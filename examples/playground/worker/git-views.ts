import type { Git } from "@kompjutr/git";
import { MAX_LISTED_CHANGES, REPO } from "../shared/protocol.js";
import { editorText, workspacePath } from "./files.js";

// Diff paths are pathspecs; Next.js routes such as `app/[slug]` must not become glob classes.
function literalPathspec(path: string): string {
  workspacePath(path);
  return path.replace(/[\\*?[\]]/g, "\\$&");
}

export function workingTreePatch(git: Git, path: string, staged: boolean) {
  return git.diff({ dir: REPO, paths: [literalPathspec(path)], staged });
}

export async function history(git: Git, ref: string | undefined, path: string | undefined) {
  if (path !== undefined) workspacePath(path);
  const commits = await git.log({
    dir: REPO,
    ref,
    depth: 21,
    firstParent: true,
    ...(path === undefined ? {} : { paths: [path] }),
  });
  return {
    commits: commits.slice(0, 20).map((commit) => ({
      oid: commit.oid,
      message: commit.message,
      author: commit.author.name,
      timestamp: commit.author.timestamp,
    })),
    next: commits[20]?.oid ?? null,
  };
}

export async function showCommit(git: Git, ref: string) {
  const { commit } = await git.show({ dir: REPO, ref });
  const person = ({ name, email, timestamp }: typeof commit.author) => ({ name, email, timestamp });
  return {
    oid: commit.oid,
    message: commit.message,
    author: person(commit.author),
    committer: person(commit.committer),
    parents: commit.parent,
  };
}

export async function changes(git: Git, from: string, to: string) {
  const files = await git.diffSummary({ dir: REPO, ref: from, to });
  return { files: files.slice(0, MAX_LISTED_CHANGES), total: files.length };
}

export function revisionPatch(git: Git, from: string, to: string, paths: string[]) {
  return git.diff({ dir: REPO, ref: from, to, paths: paths.map(literalPathspec) });
}

export async function revisionFile(git: Git, ref: string, path: string) {
  workspacePath(path);
  const { bytes } = await git.catFile({ dir: REPO, oid: ref, filepath: path });
  return { path, text: editorText(bytes), bytes: bytes.byteLength };
}

export async function compare(git: Git, base: string, head: string) {
  const baseOid = await git.revParse({ dir: REPO, ref: base });
  const headOid = await git.revParse({ dir: REPO, ref: head });
  const divergence = await git.divergence({ dir: REPO, current: headOid, upstream: baseOid });
  const mergeBase = await git.mergeBase({ dir: REPO, current: baseOid, incoming: headOid });
  return {
    base: baseOid,
    head: headOid,
    relationship: divergence.relationship,
    ahead: divergence.ahead,
    behind: divergence.behind,
    mergeBases: [...mergeBase.bases],
  };
}
