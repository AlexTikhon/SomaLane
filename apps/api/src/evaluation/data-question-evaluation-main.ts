import { invocationDirectory, runDataQuestionEvaluationCli } from './data-question-evaluation-cli.js';

// The "Ask my data" interpretation evaluation (ADR-0094), separate from the meal-draft gate. Commands, paths and exit codes
// are documented in data-question-evaluation-cli.ts and docs/runbooks/ask-my-data.md.
//
// `npm run` starts this script inside the API workspace; relative --report and --out paths mean the directory the command
// was typed in (npm's INIT_CWD), or the working directory when the script is run directly.

runDataQuestionEvaluationCli(process.argv.slice(2), {
  fetch: globalThis.fetch.bind(globalThis),
  info: (line) => console.log(line),
  invocationDirectory: invocationDirectory(process.env, process.cwd()),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`eval:data-questions failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 3;
  },
);
