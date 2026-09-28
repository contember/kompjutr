// The system commands against uutils coreutils 0.2.2 through Bash: `env -i`,
// `date -d`, the SHA checksums, `base64`, and their clap diagnostics. The
// clock, the host environment, and random names cannot be compared; those
// forms are pinned in system.test.ts.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const BINARY = Uint8Array.from({ length: 300 }, (_, index) => (index * 37) % 256);

const TREE: ShellTree = {
  "a.txt": "hello\n",
  "b c.txt": "x",
  "empty.txt": "",
  "bin.dat": BINARY,
  "dir/inner.txt": "inner\n",
  "back\\slash.txt": "a\\b",
  "encoded.txt": "aGVsbG8gd29ybGQ=\n",
  "wrapped.txt": "aGVs\nbG8g\r\nd29y\nbGQ=\n",
  "garbage.txt": "aGVs*bG8=",
  "sums.txt":
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.txt\n" +
    "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  b c.txt\n",
  "mixed.txt":
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.txt\n" +
    "0000000000000000000000000000000000000000000000000000000000000000  b c.txt\n" +
    "not a checksum line\n" +
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  missing.txt\n" +
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  dir\n",
  "tagged.txt":
    "SHA256 (a.txt) = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n",
  "junk.txt": "junk\n# comment\n\n",
};

describe("the system parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("system commands match uutils coreutils", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "env -i",
    "env -i A=1 B=2",
    "env -i B=2 A=1",
    "env -i A=1 B=2 A=3",
    "env -i A=1 B=2 env",
    "env -i B=2 A=1 env -u B C=3 env",
    "env -i -0 A=1 B=2",
    "env -i --null A=1",
    "env -iu X A=1 env",
    "env -i --unset=X A=1",
    "env - A=1",
    "env -i A=1 -u A env",
    "env -i A=1 -- env",
    "env -i =x",
    "env -i A= env",
    "env -i A=1 echo hi",
    "env -i A=1 false",
    "env -i A=1 true",
    "env -i nosuch",
    "env -i A=1 nosuch arg",
    "env -i cd /",
    "env -i -0 A=1 echo x",
    "env -i -u 'A=B' env",
    "env -x",
    "env --bogus",
    "env -u",
    "env -i -i",
    "env -0 -0 -i",
    "env -i A=1 env | wc -l",
  ])("env: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "date -d @0",
    "date -d @1700000000",
    "date -u -d @1700000000",
    "date --date=@5",
    "date -d@5",
    "date -d @+5",
    "date -d @-0",
    "date -d @1.5",
    "date -d @1700000000 -d @5",
    "date -d @1700000000 -R",
    "date -d @1700000000 --rfc-email",
    "date -d @1700000000 --rfc-822",
    "date -d @1700000000 -I",
    "date -d @1700000000 -Idate",
    "date -d @1700000000 -Ihours",
    "date -d @1700000000 -Iminutes",
    "date -d @1700000000 -Iseconds",
    "date -d @1700000000 --iso-8601=seconds",
    "date -I -d @0",
    "date -d @1700000000 --rfc-3339=date",
    "date -d @1700000000 --rfc-3339=seconds",
    "date -d 2024-01-02",
    "date -d 2024-1-2",
    "date -d 2024-02-29",
    "date -d 2024-01-02T03:04:05Z",
    "date -d 2024-01-02t03:04:05z",
    "date -d 2024-01-02T03:04:05",
    "date -d '2024-01-02 03:04:05'",
    "date -d '2024-01-02 03:04'",
    "date -d 2024-01-02T03:04Z",
    "date -d '2024-01-02 03:04:05Z'",
    "date -d '2024-01-02T03:04:05 UTC'",
    "date -d 2024-01-02T03:04:05+02:00",
    "date -d 2024-01-02T03:04:05+0200",
    "date -d 2024-01-02T03:04:05-02",
    "date -d 2024-01-02T03:04:05.5",
    "date -d 2024-01-02T03:04:05,5",
    "date -d ' 2024-01-02'",
    "date -d 1969-12-31T23:59:59Z",
    "date -d 2024-01-02T15:04:05Z '+%I %p %l %P %-l %_l %0l %0k %-k'",
    "date -d 2024-01-02T00:04:05Z '+%I %p %l %-I'",
    "date -d 2024-03-05T07:08:09Z '+%Y|%m|%d|%H|%M|%S|%s|%j|%a|%A|%b|%B|%e|%F|%T|%D|%Z|%z|%u|%w|%y|%p|%I|%%'",
    "date -d 2024-03-05T07:08:09Z '+%-d|%-m|%_m|%0e|%-e|%_H|%k|%l|%P|%C|%h|%n|%t|%R|%q|%:z|%::z|%:::z|%-j|%_j|%10Y|%^a'",
    "date -d 2024-03-05T07:08:09Z '+[%5d][%-5d][%_5d][%05e][%5a][%-5a][%05a][%^B][%#a][%#Z][%^p][%#p]'",
    "date -d 2024-03-05T07:08:09Z '+[%3s][%_3j][%12s][%-y][%_C][%_Y][%-10Y][%5%][%5n][%4z][%_z][%-z]'",
    "date -d 2024-03-05T07:08:09Z '+[%10:z][%^b][%^A][%#A][%#B][%^Z][%#P][%_I][%-H][%_S][%-S][%_s]'",
    "date -d 2024-03-05T07:08:09Z '+[%-s][%_u][%0u][%3u][%-:z][%_5a][%^5a][%_5Y][%-3j][%0k][%_H][%^%]'",
    "date -d 2024-03-05T07:08:09Z '+%G %g %V %U %W'",
    "date -d 2021-01-01T00:00:00Z '+%G %g %V %U %W %j %u %w'",
    "date -d 2020-12-31T00:00:00Z '+%G %V %U %W %j'",
    "date -d 2024-12-30 '+%G %V %U %W'",
    "date -d 2023-01-01 '+%G %V %U %W'",
    "date -d 2024-03-05 +%Y%m%d",
    "date -d 2024-03-05 +",
    "date -d 2024-03-05 '+%'",
    "date -d 2024-03-05 '+%-'",
    "date -d 2024-03-05 '+%5'",
    "date -d 2024-03-05 '+%K'",
    "date -d 2024-03-05 '+%Ey'",
    "date -d 2024-03-05 '+%-_d'",
    "date -d 1968-03-05 '+%y'",
    "date -d 1969-03-05 '+%y %D'",
    "date -d @x",
    "date -d @",
    "date -d @1e3",
    "date -d @9999999999999",
    "date -d 2024-13-01",
    "date -d 2024-02-30",
    "date -d 2023-02-29",
    "date -d 2024-01-02T25:00:00",
    "date -d 2024-01-02T03:04:60",
    "date -d 10000-01-01",
    "date -d",
    "date --rfc-3339",
    "date -d @0 --rfc-3339=bad",
    "date -d @0 -Ibad",
    "date -d @0 -I +%Y",
    "date -d @0 -u -u",
    "date -d @0 -R -R",
    "date -d @0 --iso-8601=seconds -u",
  ])("date: %j", async (source) => {
    await compare(source);
  });

  it.each(["sha1sum", "sha256sum", "sha512sum"])("%s hashes files and stdin", async (name) => {
    await compare(`${name} a.txt 'b c.txt' empty.txt bin.dat`);
    await compare(`printf hi | ${name}`);
    await compare(`printf hi | ${name} - a.txt`);
    await compare(`${name} -b a.txt`);
    await compare(`${name} -t a.txt`);
    await compare(`${name} --tag a.txt bin.dat`);
    await compare(`${name} 'back\\slash.txt'`);
    await compare(`${name} --tag 'back\\slash.txt'`);
    await compare(`${name} -z a.txt 'back\\slash.txt'`);
  });

  it.each([
    "sha256sum missing.txt a.txt",
    "sha256sum 'x y.txt' \"a'b\"",
    "base64 'x y.txt'",
    'base64 "a\'b"',
    "env -i TZ=UTC date -d @0",
    "env -i A=1 sha256sum a.txt",
    "sha256sum a.txt dir a.txt",
    "sha256sum dir",
    "sha256sum --tag -b a.txt",
    "sha256sum --quiet a.txt",
    "sha256sum --status a.txt",
    "sha256sum --strict a.txt",
    "sha256sum --ignore-missing a.txt",
    "sha256sum -w a.txt",
    "sha256sum -x",
    "sha256sum --bogus a.txt",
    "sha256sum -c sums.txt",
    "sha256sum --check sums.txt",
    "sha256sum -c mixed.txt",
    "sha256sum -c --quiet mixed.txt",
    "sha256sum -c --status mixed.txt",
    "sha256sum -c --status sums.txt",
    "sha256sum -c -w mixed.txt",
    "sha256sum -c --status -w mixed.txt",
    "sha256sum -c -q -w -s mixed.txt",
    "sha256sum -c -s -q mixed.txt",
    "sha256sum -c --strict sums.txt",
    "sha256sum -c --strict mixed.txt",
    "sha256sum -c --ignore-missing mixed.txt",
    "sha256sum -c tagged.txt",
    "sha256sum -c junk.txt",
    "sha256sum -c missing.txt",
    "sha256sum -c dir",
    "sha256sum -c sums.txt mixed.txt",
    "sha256sum -c -b sums.txt",
    "sha256sum -c --tag sums.txt",
    "sha256sum --tag -c sums.txt",
    "sha256sum a.txt | sha256sum -c",
    "sha256sum a.txt | sha256sum -c -",
    "sha1sum a.txt | sha256sum -c",
    "sha256sum --tag a.txt | sha256sum -c",
    "sha1sum --tag a.txt | sha256sum -c",
    "sha256sum 'back\\slash.txt' | sha256sum -c",
    "printf 'x' | sha256sum -c",
    "printf 'abc  a.txt\\n' | sha256sum -c",
    "printf 'ABCDEF  a.txt\\n' | sha256sum -c",
    "printf '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03 a.txt\\n' | sha256sum -c",
    "printf '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03 *a.txt\\n' | sha256sum -c",
    "printf '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.txt\\r\\n' | sha256sum -c",
    "printf '\\\\5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.txt\\n' | sha256sum -c",
    "printf '5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03  a.txt\\n' | sha256sum -c",
  ])("checksum edge: %j", async (source) => {
    await compare(source);
  });

  // Listed names unescape `\\` and `\n`; diagnostics quote a name only when a
  // shell would need it.
  it.each([
    "back\\\\slash.txt",
    "back\\slash.txt",
    "x y.txt",
    "a*b",
    "a=b",
    "~a",
    "a~",
    "#a",
    "a#",
    "a'b",
    'a"b',
    "a!b",
    "a,b",
    "a]b",
    "a{b",
    "-a",
    "a^b",
    "a;b",
    "a\\nb",
  ])("checksum names: %j", async (name) => {
    const digest = "c62016d0f8ee333350283fd879b50b692932e932794e5d686f7d37d67484e199";
    await compare(`printf '%s  %s\\n' ${digest} '${name.replaceAll("'", "'\\''")}' | sha256sum -c`);
  });

  it.each([
    "printf 'hello world' | base64",
    "printf '' | base64",
    "base64 a.txt",
    "base64 bin.dat",
    "base64 -w 10 bin.dat",
    "base64 -w0 bin.dat",
    "base64 --wrap=7 a.txt",
    "base64 -w 8 a.txt",
    "base64 -w 5 -w 6 a.txt",
    "base64 - < a.txt",
    "base64 empty.txt",
    "base64 bin.dat | base64 -d | sha256sum",
    "base64 -w 3 bin.dat | base64 -d | wc -c",
    "base64 -d encoded.txt",
    "base64 --decode wrapped.txt",
    "base64 -d garbage.txt",
    "base64 -di garbage.txt",
    "base64 -d --ignore-garbage garbage.txt",
    "base64 -D encoded.txt",
    "base64 -d -w 5 encoded.txt",
    "printf 'aGVsbG8' | base64 -d",
    "printf 'aGVsbA' | base64 -d",
    "printf 'aGVsbG' | base64 -d",
    "printf 'YQ' | base64 -d",
    "printf 'YQ=' | base64 -d",
    "printf 'YQ==' | base64 -d",
    "printf 'YQ=\\n=' | base64 -d",
    "printf 'YR==' | base64 -d",
    "printf 'Y' | base64 -d",
    "printf 'YW' | base64 -d",
    "printf 'YWI' | base64 -d",
    "printf 'YWJj=' | base64 -d",
    "printf 'YQ==YQ==' | base64 -d",
    "printf 'aGVs bG8=' | base64 -d",
    "printf 'YQ==\\t' | base64 -d",
    "printf '=' | base64 -d",
    "printf 'YQ=*=' | base64 -di",
    "printf 'YQ===' | base64 -di",
    "printf 'a=b' | base64 -di",
    "base64 missing.txt",
    "base64 dir",
    "base64 a.txt a.txt",
    "base64 -w x a.txt",
    "base64 -w -1 a.txt",
    "base64 -w",
    "base64 -w -d a.txt",
    "base64 -dx a.txt",
    "base64 --dec encoded.txt",
    "base64 --wra 5 a.txt",
  ])("base64: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sleep 0",
    "sleep 0.01 0.01s 0m 0h 0d",
    "sleep .001",
    "sleep 1e-3",
    "sleep +0.001",
    "sleep -- 0",
    "sleep ' 0'",
    "sleep",
    "sleep x",
    "sleep 1x",
    "sleep ''",
    "sleep 0 x y",
    "sleep -1",
    "sleep --bogus",
    "sleep 0 -- -1",
  ])("sleep: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "mktemp fooXX",
    "mktemp ''",
    "mktemp a b",
    "mktemp -z",
    "mktemp -p",
    "mktemp -d -d",
    "mktemp -u -u",
    "mktemp -t a/XXX",
    "mktemp -p . /abs/XXX",
    "mktemp XXX/a",
    "mktemp --suffix=/x XXX",
    "mktemp --suffix=.x aXXXb",
    "mktemp nodir/XXXX",
    "mktemp -d nodir/XXXX",
    "mktemp -q nodir/XXXX",
  ])("mktemp: %j", async (source) => {
    await compare(source);
  });
});
