import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  type InitialRecord,
  JournalWriter,
  MAX_JOURNAL_RECORDS,
  MAX_RECOVERY_ACTIONS,
  readJournal,
} from "../../packages/local/src/recovery/journal.js";

describe("local recovery journal", () => {
  it("rejects semantically conflicting records even when every frame is valid", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-journal-test-"));
    const path = join(directory, "journal");
    const writer = new JournalWriter(path);
    try {
      writer.append({
        kind: "initial",
        sequence: 0,
        version: 1,
        transaction: "01234567-89ab-cdef-0123-456789abcdef",
        baseGeneration: 1,
        targetGeneration: 2,
      });
      writer.append({
        kind: "application",
        touches: [
          { path: "/duplicated", backup: null },
          { path: "/duplicated", backup: null },
        ],
      });
    } finally {
      writer.close();
    }
    try {
      expect(() => readJournal(path)).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("splits one application intent into independently synced readable frames", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-journal-split-test-"));
    const path = join(directory, "journal");
    const transaction = "01234567-89ab-cdef-0123-456789abcdef";
    const touches = Array.from({ length: 5 }, (_, index) => ({
      path: `/${String(index).repeat(50)}`,
      backup: null,
    }));
    const writer = new JournalWriter(path, MAX_JOURNAL_RECORDS, MAX_RECOVERY_ACTIONS, 180);
    try {
      writer.append({
        kind: "initial",
        sequence: 0,
        version: 1,
        transaction,
        baseGeneration: 1,
        targetGeneration: 2,
      });
      writer.appendApplication(touches);
    } finally {
      writer.close();
    }
    try {
      expect(() => readJournal(path, 2)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(readJournal(path)?.touches).toEqual(touches);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("bounds aggregate recovery actions in the writer and reader", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-journal-actions-test-"));
    const writerPath = join(directory, "writer-journal");
    const readerPath = join(directory, "reader-journal");
    const initial: InitialRecord = {
      kind: "initial",
      sequence: 0,
      version: 1,
      transaction: "01234567-89ab-cdef-0123-456789abcdef",
      baseGeneration: 1,
      targetGeneration: 2,
    };
    const limited = new JournalWriter(writerPath, MAX_JOURNAL_RECORDS, 1);
    try {
      limited.append(initial);
      expect(() =>
        limited.appendApplication([
          { path: "/one", backup: null },
          { path: "/two", backup: null },
        ]),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    } finally {
      limited.close();
    }
    const readable = new JournalWriter(readerPath);
    try {
      readable.append(initial);
      readable.appendApplication([
        { path: "/one", backup: null },
        { path: "/two", backup: null },
      ]);
    } finally {
      readable.close();
    }
    try {
      expect(readJournal(writerPath)?.touches).toEqual([]);
      expect(() => readJournal(readerPath, MAX_JOURNAL_RECORDS, 1)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects NUL in recovery paths before settlement", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-journal-nul-test-"));
    const path = join(directory, "journal");
    const writer = new JournalWriter(path);
    try {
      writer.append({
        kind: "initial",
        sequence: 0,
        version: 1,
        transaction: "01234567-89ab-cdef-0123-456789abcdef",
        baseGeneration: 1,
        targetGeneration: 2,
      });
      expect(() =>
        writer.append({ kind: "application", touches: [{ path: "/bad\0path", backup: null }] }),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    } finally {
      writer.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a writer record beyond the reader limit before persisting it", () => {
    expect(MAX_JOURNAL_RECORDS).toBe(100_000);
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-journal-limit-test-"));
    const path = join(directory, "journal");
    const writer = new JournalWriter(path, 2);
    try {
      writer.append({
        kind: "initial",
        sequence: 0,
        version: 1,
        transaction: "01234567-89ab-cdef-0123-456789abcdef",
        baseGeneration: 1,
        targetGeneration: 2,
      });
      writer.append({ kind: "application", touches: [{ path: "/file", backup: null }] });
      expect(() =>
        writer.append({ kind: "temporary", parent: "/", name: ".kompjutr-tmp-extra-0" }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    } finally {
      writer.close();
    }
    try {
      expect(readJournal(path, 2)?.touches).toEqual([{ path: "/file", backup: null }]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
