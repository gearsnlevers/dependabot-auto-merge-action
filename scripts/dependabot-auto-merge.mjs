#!/usr/bin/env node
/*
 * Arms auto-merge on Dependabot pull requests under the policy of core record 0023 (see policy.mjs and the README).
 *
 *   node scripts/dependabot-auto-merge.mjs --repo <owner/name> --pr <number> [options]    one pull request
 *   node scripts/dependabot-auto-merge.mjs --repo <owner/name> --all [options]            every open Dependabot pull request
 *
 *   --config <path>        dependabot.yml in the repository, read from its DEFAULT BRANCH (default .github/dependabot.yml)
 *   --min-age-days <n>     the age that every added version must have (default 7)
 *   --as-of <iso>          the clock, for a dry run against an earlier day
 *   --dry-run              decide and say so, arm nothing
 *   --ignore-state         with --dry-run only: also look at a pull request that is closed or merged
 *
 * Needs Node 20 or later, `gh` with GH_TOKEN, and the npm registry; nothing else, no package to install.
 * Exit code: 0 when every pull request was decided (armed or not), 1 when the policy cannot be read or an arming
 * failed, 2 for a wrong command line.
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseYaml, toolingFromConfig } from './dependabot-yml.mjs';
import { evaluate } from './evaluate.mjs';
import { MIN_AGE_DAYS } from './policy.mjs';

const execFileAsync = promisify(execFile);

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONFIG_PATH = /^[A-Za-z0-9_.\/-]+$/;

/** Run `gh` and return its stdout. */
export async function ghDefault(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** Read and parse a JSON document, one attempt (the caller retries). */
export async function fetchJsonDefault(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Check the command line.
 * @param {string[]} argv the arguments
 * @param {Record<string,string|undefined>} env the environment
 * @returns {{repo:string,pr?:number,all:boolean,config:string,minAgeDays:number,now:number,dryRun:boolean,ignoreState:boolean}} the options
 * @throws {Error} with the usage when something is wrong
 */
export function parseArguments(argv, env = {}) {
  const usage =
    'usage: dependabot-auto-merge.mjs (--pr <number> | --all) [--repo owner/name] [--config <path>] [--min-age-days <n>] [--as-of <iso>] [--dry-run] [--ignore-state]';
  const repo = option(argv, '--repo') ?? env.GITHUB_REPOSITORY;
  const all = argv.includes('--all');
  const prText = option(argv, '--pr');
  const pr = prText === undefined ? undefined : Number(prText);
  const config = option(argv, '--config') ?? '.github/dependabot.yml';
  const minAgeDays = Number(option(argv, '--min-age-days') ?? MIN_AGE_DAYS);
  const asOf = option(argv, '--as-of');
  const now = asOf === undefined ? Date.now() : Date.parse(asOf);
  const dryRun = argv.includes('--dry-run');
  const ignoreState = argv.includes('--ignore-state');
  if (!repo || !REPO.test(repo)) throw new Error(`${usage}\nthe repository must be owner/name`);
  if (all === (pr !== undefined)) throw new Error(`${usage}\ngive exactly one of --pr and --all`);
  if (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) throw new Error(`${usage}\n--pr must be a pull request number`);
  if (!CONFIG_PATH.test(config) || config.split('/').includes('..') || config.startsWith('/')) {
    throw new Error(`${usage}\n--config must be a path inside the repository`);
  }
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) throw new Error(`${usage}\n--min-age-days must be a number`);
  if (!Number.isFinite(now)) throw new Error(`${usage}\n--as-of must be a date`);
  if (ignoreState && !dryRun) throw new Error(`${usage}\n--ignore-state needs --dry-run`);
  return { repo, pr, all, config, minAgeDays, now, dryRun, ignoreState };
}

/** One line of text for a log: no line break, and never a line that the runner reads as a command (`::`). */
function oneLine(text) {
  return String(text).replace(/[\r\n\u0000-\u001f]+/g, ' ');
}

function summaryRow(r) {
  const cell = (t) => oneLine(t).replace(/[|`<>]/g, ' ');
  return `| #${r.number} | ${cell(r.action)} | ${cell(r.title)} | ${cell(r.reasons.slice(0, 3).join('; '))} |`;
}

/**
 * Run the action once.
 * @param {object} io what to run with (all replaceable in tests)
 * @param {string[]} io.argv the arguments
 * @param {Record<string,string|undefined>} [io.env] the environment
 * @param {(args: string[]) => Promise<string>} [io.gh] runs `gh`
 * @param {(url: string) => Promise<any>} [io.fetchJson] reads a JSON document
 * @param {(line: string) => void} [io.log] where lines go
 * @param {(file: string, text: string) => void} [io.append] appends to a file (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY)
 * @returns {Promise<number>} the exit code
 */
export async function run({
  argv,
  env = process.env,
  gh = ghDefault,
  fetchJson = fetchJsonDefault,
  log = console.log,
  append = appendFileSync,
}) {
  let options;
  try {
    options = parseArguments(argv, env);
  } catch (error) {
    log(String(error.message));
    return 2;
  }
  const { repo, config, minAgeDays, now, dryRun, ignoreState } = options;

  // the policy comes from the default branch of the repository, never from a pull request
  let tooling;
  try {
    const branch = (await gh(['api', `repos/${repo}`, '--jq', '.default_branch'])).trim();
    if (!/^[^\s~^:?*[\\]+$/.test(branch)) throw new Error('no usable default branch');
    const text = await gh([
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${repo}/contents/${config}?ref=${encodeURIComponent(branch)}`,
    ]);
    tooling = toolingFromConfig(parseYaml(text));
  } catch (error) {
    log(`The policy cannot be read, so nothing is armed: ${oneLine(error.message)}`);
    return 1;
  }

  let numbers;
  if (options.all) {
    const open = JSON.parse(
      await gh(['pr', 'list', '-R', repo, '--author', 'app/dependabot', '--state', 'open', '--limit', '100', '--json', 'number'])
    );
    numbers = open.map((p) => p.number);
  } else {
    numbers = [options.pr];
  }

  const cache = new Map();
  const results = [];
  let failed = false;
  for (const number of numbers) {
    let result;
    try {
      result = await evaluate({ repo, number, gh, fetchJson, now, tooling, minAgeDays, cache, ignoreState });
    } catch (error) {
      failed = true;
      log(`#${number} FAILED: ${oneLine(error.message)}`);
      results.push({ number, title: '', action: 'failed', arm: false, retryLater: true, reasons: [oneLine(error.message)] });
      continue;
    }
    const { arm, retryLater, reasons } = result.verdict;
    let action;
    if (arm && result.alreadyArmed) action = 'already armed';
    else if (arm && dryRun) action = 'would arm';
    else if (arm) action = 'armed';
    else action = retryLater ? 'skipped, look again later' : 'skipped, a person merges it';
    if (action === 'armed') {
      try {
        await gh(['pr', 'merge', String(number), '-R', repo, '--auto', '--squash']);
      } catch (error) {
        failed = true;
        action = 'failed to arm';
        reasons.push(oneLine(String(error.message).split('\n')[0]));
      }
    }
    log(`#${number} ${action.toUpperCase()}: ${oneLine(result.title)}`);
    for (const reason of reasons.slice(0, 12)) log(`    ${oneLine(reason)}`);
    if (reasons.length > 12) log(`    ... and ${reasons.length - 12} more`);
    results.push({
      number,
      title: oneLine(result.title),
      action,
      arm,
      retryLater,
      alreadyArmed: result.alreadyArmed,
      reasons: reasons.map(oneLine),
    });
  }
  if (results.length === 0) log('No open Dependabot pull request.');

  if (env.GITHUB_OUTPUT) {
    // JSON.stringify leaves no line break in the text, so a single `name=value` line is a safe output
    append(env.GITHUB_OUTPUT, `verdicts=${JSON.stringify(results)}\n`);
    append(
      env.GITHUB_OUTPUT,
      `armed=${results.filter((r) => r.action === 'armed' || r.action === 'already armed').map((r) => r.number).join(',')}\n`
    );
  }
  if (env.GITHUB_STEP_SUMMARY && results.length > 0) {
    append(
      env.GITHUB_STEP_SUMMARY,
      ['| Pull request | Result | Title | Why |', '| --- | --- | --- | --- |', ...results.map(summaryRow)].join('\n') + '\n'
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.error(`Node 20 or later is needed, this is ${process.versions.node}`);
    process.exit(2);
  }
  run({ argv: process.argv.slice(2) }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(oneLine(error?.message ?? error));
      process.exit(1);
    }
  );
}
