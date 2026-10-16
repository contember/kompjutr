import { useState } from "react";
import { type Comparison, compareSchema } from "../shared/protocol.js";
import { type Measurement, request } from "./api.js";
import { ChangeSet, type RevisionTarget } from "./change-set.js";

interface Props {
  branches: string[];
  branch: string;
  disabled: boolean;
  openRevision(target: RevisionTarget): void;
  onError(message: string): void;
  onMeasure(measurement: Measurement): void;
}

interface ComparedRefs {
  baseName: string;
  headName: string;
}

function summary(result: Comparison & ComparedRefs): string {
  switch (result.relationship) {
    case "identical":
      return "Both revisions point at the same commit.";
    case "unrelated":
      return "The revisions share no history.";
    case "shallow":
      return "The shallow boundary hides the common history.";
    default:
      return `${result.headName}: ${result.ahead} ahead, ${result.behind} behind ${result.baseName}.`;
  }
}

export function Compare({ branches, branch, disabled, openRevision, onError, onMeasure }: Props) {
  const [base, setBase] = useState(branches.includes("main") ? "main" : branch);
  const [head, setHead] = useState(branch);
  const [result, setResult] = useState<Comparison & ComparedRefs>();
  const [loading, setLoading] = useState(false);
  const mergeBase = result?.mergeBases[0];

  async function run() {
    setLoading(true);
    try {
      const response = await request({ action: "compare", base, head }, compareSchema);
      setResult({ ...response.data, baseName: base, headName: head });
      onMeasure(response.measurement);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form
        className="compare-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <datalist id="compare-branches">
          {branches.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <label>
          Base
          <input
            list="compare-branches"
            value={base}
            spellCheck={false}
            onChange={(event) => setBase(event.target.value)}
          />
        </label>
        <label>
          Compare
          <input
            list="compare-branches"
            value={head}
            spellCheck={false}
            onChange={(event) => setHead(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="accent-button"
          disabled={disabled || loading || base.trim() === "" || head.trim() === ""}
        >
          Compare
        </button>
        <div className="subtle">Branch, tag, or commit · changes since the merge base</div>
      </form>
      {result !== undefined && (
        <>
          <div className="compare-summary">
            <code>
              {result.base.slice(0, 8)}...{result.head.slice(0, 8)}
            </code>
            <span>{summary(result)}</span>
            {result.mergeBases.length > 1 && (
              <span className="subtle">
                {result.mergeBases.length} merge bases; showing changes from the first.
              </span>
            )}
          </div>
          {mergeBase !== undefined && (
            <ChangeSet
              from={mergeBase}
              to={result.head}
              disabled={disabled}
              openRevision={openRevision}
              onError={onError}
              onMeasure={onMeasure}
            />
          )}
        </>
      )}
    </>
  );
}
