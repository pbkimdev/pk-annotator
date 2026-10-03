import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/practice")({ component: Practice });

type Case = { nums: number[]; target: number; expected: number[] };
type Outcome = { input: string; expected: string; actual: string; passed: boolean };
const Verdict = z.strictObject({
  status: z.enum(["Accepted", "Wrong Answer"]),
  passed: z.number(),
  total: z.number(),
  runtimeMs: z.number(),
});
type Verdict = z.infer<typeof Verdict>;

const CASES: Case[] = [
  { nums: [2, 7, 11, 15], target: 9, expected: [0, 1] },
  { nums: [3, 2, 4], target: 6, expected: [1, 2] },
  { nums: [3, 3], target: 6, expected: [0, 1] },
];

const STARTER = `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const rest = target - nums[i];
    if (seen.has(rest)) return [seen.get(rest), i];
    seen.set(nums[i], i);
  }
  console.log("no pair for", target);
  return [];
}`;

// Runs in the page on purpose: console output and thrown errors from the candidate's code
// are what the overlay's capture should record.
function runCases(code: string): Outcome[] {
  const twoSum = z
    .instanceof(Function, { message: "Define a function named twoSum" })
    .parse(new Function(`${code}\nreturn twoSum;`)());
  return CASES.map((testCase) => {
    const actual = JSON.stringify(twoSum([...testCase.nums], testCase.target));
    const expected = JSON.stringify(testCase.expected);
    return {
      input: `nums = ${JSON.stringify(testCase.nums)}, target = ${testCase.target}`,
      expected,
      actual,
      passed: actual === expected,
    };
  });
}

function Practice() {
  const [code, setCode] = useState(STARTER);
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState<"cases" | "result">("cases");
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A consumer-sized root font, so the overlay must not inherit rem sizes from the page.
  useEffect(() => {
    document.documentElement.style.fontSize = "20px";
    return () => {
      document.documentElement.style.fontSize = "";
    };
  }, []);

  const run = () => {
    setTab("result");
    setVerdict(null);
    try {
      setOutcomes(runCases(code));
      setRunError(null);
    } catch (error) {
      setOutcomes(null);
      setRunError(error instanceof Error ? error.message : String(error));
      console.error("practice: run failed", error);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setTab("result");
    try {
      const results = runCases(code);
      setOutcomes(results);
      setRunError(null);
      const response = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem: "two-sum",
          language: "javascript",
          code,
          passed: results.filter((outcome) => outcome.passed).length,
          total: results.length,
        }),
      });
      if (!response.ok) throw new Error(`submit returned ${response.status}`);
      setVerdict(Verdict.parse(await response.json()));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
      console.error("practice: submit failed", error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="practice" data-theme={dark ? "dark" : "light"} data-testid="practice">
      <style>{STYLES}</style>
      <section className="problem" aria-labelledby="problem-title">
        <header>
          <h1 id="problem-title" data-testid="practice-title">
            1. Two Sum
          </h1>
          <span className="difficulty">Easy</span>
          <button type="button" data-testid="practice-theme" onClick={() => setDark(!dark)}>
            {dark ? "Light" : "Dark"} theme
          </button>
        </header>
        <p>
          Given an array of integers <code>nums</code> and an integer <code>target</code>, return
          the indices of the two numbers that add up to <code>target</code>.
        </p>
        <p>Each input has exactly one solution, and the same element may not be used twice.</p>
        <h2>Example 1</h2>
        <pre>Input: nums = [2,7,11,15], target = 9{"\n"}Output: [0,1]</pre>
        <h2>Constraints</h2>
        <ul>
          <li>
            <code>2 ≤ nums.length ≤ 10⁴</code>
          </li>
          <li>
            <code>-10⁹ ≤ nums[i], target ≤ 10⁹</code>
          </li>
        </ul>
      </section>
      <section className="workspace">
        <div className="toolbar">
          <select aria-label="Language" defaultValue="javascript">
            <option value="javascript">JavaScript</option>
          </select>
          <button type="button" data-testid="practice-reset" onClick={() => setCode(STARTER)}>
            Reset
          </button>
          <button type="button" data-testid="practice-run" onClick={run}>
            Run
          </button>
          <button
            type="button"
            className="primary"
            data-testid="practice-submit"
            disabled={submitting}
            onClick={submit}
          >
            {submitting ? "Judging…" : "Submit"}
          </button>
        </div>
        <textarea
          aria-label="Code"
          data-testid="practice-editor"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <div className="console">
          <div role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "cases"}
              onClick={() => setTab("cases")}
            >
              Testcases
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "result"}
              onClick={() => setTab("result")}
            >
              Result
            </button>
          </div>
          {tab === "cases" ? (
            <ol data-testid="practice-cases">
              {CASES.map((testCase) => (
                <li key={JSON.stringify(testCase)}>
                  <code>
                    nums = {JSON.stringify(testCase.nums)}, target = {testCase.target}
                  </code>
                </li>
              ))}
            </ol>
          ) : (
            <div data-testid="practice-result">
              {verdict && (
                <p className={verdict.status === "Accepted" ? "pass" : "fail"}>
                  {verdict.status} · {verdict.passed}/{verdict.total} · {verdict.runtimeMs} ms
                </p>
              )}
              {runError !== null && (
                <p className="fail" role="alert">
                  {runError}
                </p>
              )}
              {outcomes && (
                <table>
                  <thead>
                    <tr>
                      <th>Input</th>
                      <th>Expected</th>
                      <th>Output</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes.map((outcome) => (
                      <tr key={outcome.input} className={outcome.passed ? "pass" : "fail"}>
                        <td>
                          <code>{outcome.input}</code>
                        </td>
                        <td>
                          <code>{outcome.expected}</code>
                        </td>
                        <td>
                          <code>{outcome.actual}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!outcomes && runError === null && <p>Run your code to see results.</p>}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

const STYLES = `
.practice {
  --bg: #f7f7f8; --panel: #fff; --text: #1d1d22; --muted: #6b6b76; --line: #e2e2e8;
  --accent: #2f6fde; --pass: #1f8a4c; --fail: #c4352b;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 0.6rem;
  min-height: 80vh; padding: 0.6rem; background: var(--bg); color: var(--text);
  font: 0.8rem/1.5 system-ui, sans-serif;
}
.practice[data-theme="dark"] {
  --bg: #16171b; --panel: #1f2026; --text: #e8e8ec; --muted: #9a9aa6; --line: #33343c;
  --accent: #6b9bff; --pass: #4cc38a; --fail: #ff6b5e;
}
.practice section { background: var(--panel); border: 1px solid var(--line); border-radius: 0.4rem; padding: 0.8rem; }
.practice header { display: flex; align-items: center; gap: 0.6rem; }
.practice h1 { font-size: 1.1rem; margin: 0; }
.practice h2 { font-size: 0.85rem; margin: 1rem 0 0.3rem; }
.practice .difficulty { color: var(--pass); font-weight: 600; }
.practice header button { margin-left: auto; }
.practice code, .practice pre, .practice textarea { font-family: ui-monospace, monospace; font-size: 0.75rem; }
.practice pre { background: var(--bg); padding: 0.5rem; border-radius: 0.3rem; white-space: pre-wrap; }
.practice .workspace { display: grid; grid-template-rows: auto 1fr auto; gap: 0.5rem; }
.practice .toolbar { display: flex; gap: 0.4rem; }
.practice .toolbar select { margin-right: auto; }
.practice button, .practice select {
  font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line);
  border-radius: 0.3rem; padding: 0.2rem 0.6rem; cursor: pointer;
}
.practice button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.practice button:disabled { opacity: 0.6; cursor: progress; }
.practice textarea {
  min-height: 16rem; resize: vertical; padding: 0.6rem; tab-size: 2;
  background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 0.3rem;
}
.practice [role="tablist"] { display: flex; gap: 0.2rem; margin-bottom: 0.4rem; }
.practice [role="tab"][aria-selected="true"] { border-color: var(--accent); color: var(--accent); }
.practice table { width: 100%; border-collapse: collapse; }
.practice th, .practice td { text-align: left; padding: 0.2rem 0.4rem; border-bottom: 1px solid var(--line); }
.practice .pass { color: var(--pass); }
.practice .fail { color: var(--fail); }
`;
