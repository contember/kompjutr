// `awk` against mawk 1.3.4 through Bash. Programs, field splitting, printf,
// number conversions, strnum comparisons, arrays, the builtins, records, and
// diagnostics compare byte for byte. `for (k in a)` order is not compared: the
// shell visits insertion order where mawk visits its hash order, so loops over
// several keys pipe through `sort` (the divergence is pinned locally). The refusals —
// unbounded loops, getline, redirection, recursion — are pinned locally in
// parity-awk-refusals.test.ts.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "f.txt": "alpha 10 x\nbeta 20 y\ngamma 5 z\nalpha 7 w\n",
  "p.txt": "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:User:/home/user:/bin/sh\n",
  "t.tsv": "a\tb c\td\n1\t2\t3\n",
  "para.txt": "\n\na b\nc\n\n\nd e\nf\n\n",
  "n.txt": "10\n9\n1e2\n0x10\n abc\n3.0\n-2\n",
  "g.txt": "one\ntwo\nthree\n",
  "h.txt": "x1\nx2",
  "prog.awk": 'BEGIN { FS = ":" }\n{ print $1 }\n',
  "bad.awk": "BEGIN {\n  print 1 +\n}\n",
};

describe("the awk parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("awk matches mawk", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "awk '{print $1}' f.txt",
    "awk -F: '{print $2}' p.txt",
    "awk 'NR>1 && $2 > 6 {s+=$2} END {print s}' f.txt",
    "awk '/alpha/ {c++} END {print c}' f.txt",
    "awk '!seen[$1]++' f.txt",
    "awk '{print NR\": \"$0}' f.txt",
    "awk '{a[$1]+=$2} END{for(k in a) print k, a[k]}' f.txt | sort",
    "awk 'END{print NR}' f.txt",
    "awk '{print $NF}' p.txt",
    "awk -F: '$3 >= 1000 {print $1}' p.txt",
    "awk '{sum[$1] += $2; n[$1]++} END {for (k in sum) printf \"%s %.2f\\n\", k, sum[k] / n[k]}' f.txt | sort",
    "awk 'length($0) > 10' p.txt",
    "awk '{print length}' g.txt",
    "awk 'NR==2' g.txt",
    "cat f.txt | awk '{print $2}' | sort -n | awk '{t+=$1} END{print t}'",
  ])("runs agent one-liners: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk '{print NF, $NF, $(NF-1)}' f.txt",
    "awk -F, '{print NF}' p.txt",
    "awk -F'[:/]' '{print $1, $7, NF}' p.txt",
    "awk -F: -v OFS=- '{print $1, $3}' p.txt",
    "awk 'BEGIN{FS=\":\"} {print $6}' p.txt",
    "awk -F '' '{print NF, $1, $3}' g.txt",
    "awk -F'|' '{print NF}' t.tsv",
    'awk \'BEGIN{FS="\\t"}{print $1 "|" $2}\' t.tsv',
    "awk -F'\\t' '{print $2}' t.tsv",
    "awk -F'\\t' -v OFS='|' '{$1=$1; print}' t.tsv",
    "awk -F ' ' '{print $2}' t.tsv",
    "awk -F'[ \\t]' '{print NF}' t.tsv",
    "awk -Ft '{print $1}' t.tsv",
    'echo \'  a   b  \' | awk \'{print NF"|"$1"|"$2"|"}\'',
    'echo \'a:b::c:\' | awk -F: \'{print NF, $3 "|" $4 "|" $5 "|"}\'',
    "echo 'a1b22c333d' | awk -F'[0-9]+' '{print NF, $1, $2, $3, $4}'",
    "echo 'aXbXXc' | awk -F'X*' '{print NF, $1, $2, $3}'",
    "echo 'a.b.c' | awk -F. '{print $2, NF}'",
    "printf 'a:b\\nc d\\n' | awk '{FS=\":\"; print $1}'",
  ])("splits fields: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "echo 'a b c d' | awk '{NF=2; print; print NF}'",
    "echo 'a b c' | awk '{NF=5; print $0 \"|\"; print NF}'",
    "echo 'a b c' | awk -v OFS=, '{$5=\"e\"; print}'",
    "echo 'a b c' | awk '{$2=\"\"; print; print NF}'",
    "echo 'a b c' | awk '{$0=\"x y\"; print NF, $2}'",
    "echo 'a b c' | awk '{NF++; $NF=\"z\"; print}'",
    "echo 'a b' | awk '{ $3 = $1 $2; print; print NF }'",
    "echo '5 apples' | awk '{ $1 *= 2; print }'",
    "echo '1 2 3' | awk '{ $2++; ++$3; print; print $2 $3 }'",
    "echo 'x' | awk '{ print $1$1, $ 1, $(0) }'",
    "echo 'a b c' | awk '{ i = 2; print $i, $i++, i, $++i }'",
    "echo 1 | awk '{$1 = 5; print ($0 < 10)}'",
    "echo 1 | awk '{$1 = \"5\"; print ($0 < 10)}'",
    "echo '3 4' | awk '{NF = 1; print ($0 < 10)}'",
    "awk 'BEGIN{CONVFMT=\"%.2f\"; $0 = 2.555; print $0; print $1}'",
    "echo 'a b' | awk 'BEGIN{CONVFMT=\"%.2f\"; OFMT=\"%.3f\"}{$2 = 3.14159; print; print $2}'",
  ])("assigns fields and NF: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk -v x=5 'BEGIN{print x+1}'",
    "awk -v 's=a\\tb' 'BEGIN{print s}'",
    "awk -v n=10 'BEGIN{print (n < 9), (n == \"10.0\"), (n == 10.0)}'",
    "awk '{print x, $0}' x=1 g.txt x=2 h.txt",
    "awk 'END{print x}' g.txt x=7",
    "awk '{print FILENAME, FNR, NR}' g.txt h.txt",
    "awk 'FNR==1{print FILENAME}' g.txt h.txt g.txt",
    "echo in | awk '{print FILENAME \":\" $0}'",
    "echo in | awk '{print FILENAME \":\" $0}' -",
    "echo in | awk '{print FILENAME \":\" $0}' g.txt -",
    "echo in | awk '{print FILENAME \":\" $0}' x=1",
    "awk 'BEGIN{print ARGC, ARGV[0], ARGV[1], ARGV[2]}' a b",
    "awk 'BEGIN{ARGV[1]=\"\"} {print}' nosuch g.txt",
    "awk 'BEGIN{ARGV[1]=\"h.txt\"} {print}' g.txt",
    "awk '{print}' nosuch",
    "awk '{print}' g.txt nosuch",
    "awk -f prog.awk p.txt",
    "awk -- '{print $1}' f.txt",
    "awk -F: -f prog.awk p.txt",
    "awk -v FS=: '{print $2}' p.txt",
    "mawk 'BEGIN{print ARGV[0]}'",
  ])("reads options and operands: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'awk \'BEGIN{printf "%d %i %o %x %X %u %c %s %e %f %g %%\\n", 42.9, -3, 8, 255, 255, 7, 66, "s", 1234.5, 3.14159, 0.0001}\'',
    'awk \'BEGIN{printf "[%5s][%-5s][%.2s][%5.1s]\\n", "abc", "abc", "abc", "abc"}\'',
    "awk 'BEGIN{printf \"[%5d][%-5d][%05d][%+d][% d][%.3d]\\n\", 42, 42, 42, 42, 42, 7}'",
    "awk 'BEGIN{printf \"[%8.3f][%-8.2e][%08.2f][%+.1f][%#.0f][%.0f][%.0f][%.0f]\\n\", 3.14159, 31415.9, -3.14159, 2.25, 3, 2.5, 3.5, 0.5}'",
    "awk 'BEGIN{printf \"[%g][%g][%g][%g][%G][%.3g][%#g][%g]\\n\", 100000, 1000000, 0.0001, 0.00001, 1e-10, 3.14159, 1, 123456789}'",
    "awk 'BEGIN{printf \"[%*d][%-*d][%.*f]\\n\", 6, 42, 6, 42, 2, 3.14159}'",
    'awk \'BEGIN{printf "[%c][%c][%c][%c]\\n", "hello", 65, "", 256+66}\'',
    "awk 'BEGIN{printf \"%c\", 233}'",
    "awk 'BEGIN{printf \"%#x %#o %X\\n\", 255, 8, 3000000000}'",
    'awk \'BEGIN{printf "%d %d %d\\n", "12abc", "abc", "-7.9"}\'',
    "awk 'BEGIN{printf \"%s %s %s\\n\", 1e6, 1/3, 100}'",
    'awk \'BEGIN{printf("%s-%s\\n", "a", "b")}\'',
    "awk 'BEGIN{printf \"no newline\"}'",
    'awk \'BEGIN{x = sprintf("%05.1f|%3s", 2.345, "ab"); print x}\'',
    "awk 'BEGIN{printf \"%x %o %u\\n\", -1, -1, -1}'",
    "awk 'BEGIN{printf \"%.10g %.15g %.17g\\n\", 0.1, 0.1, 0.1}'",
    "awk 'BEGIN{printf \"%e %E\\n\", 0, -0.000123456}'",
    "awk 'BEGIN{printf \"%.3e\\n\", 9.9995}'",
    "awk 'BEGIN{printf \"%d|%d|%d|%d\\n\", 2^53, 1e18, -1e19, 1e20}'",
    "awk 'BEGIN{printf \"%x|%o|%u|%x|%c\\n\", -1, -1, 2^64, 1e20, 65.7}'",
    "awk 'BEGIN{printf \"%5.2f|%d|%s\\n\", 1/0, -1/0, log(-1)}'",
    "awk 'BEGIN{printf \"%d %s\\n\", 1}'",
    "awk 'BEGIN{printf \"%z\\n\", 1}'",
    "awk 'BEGIN{printf \"%5%|\\n\", 1}'",
  ])("formats with printf: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk 'BEGIN{print 1/3, 2^10, 7%3, -7%3}'",
    "awk 'BEGIN{print 1e6, 1e16, 123456789012, 0.1+0.2, 1e20, 1e300, -0, 1/3, 2^53, 2^53+1, 100/3}'",
    'awk \'BEGIN{print 3.0, "3.0", 3.0 "", 0.1 * 3, 1e-5, 123456.7, 1234567.8}\'',
    'awk \'BEGIN{CONVFMT="%.2f"; x = 3.14159; y = x ""; print y; print x; z = 17 ""; print z}\'',
    'awk \'BEGIN{OFMT="%.2f"; print 3.14159, 17, 17.0; x = 3.14159 ""; print x}\'',
    "awk 'BEGIN{print 1/0, -1/0, log(-1), log(0), exp(1000)}'",
    'awk \'BEGIN{print int(3.9), int(-3.9), int("4.5abc"), int(""), sqrt(16), exp(0), log(1), sin(0), cos(0), atan2(0, -1)}\'',
    "awk 'BEGIN{print 2^0.5, 10 % 3, -10 % 3, 10.5 % 3}'",
    'awk \'BEGIN{print 2^3^2, -2^2, 2^-1, !0, !1, !"", !"a", - -3}\'',
    "awk 'BEGIN { print 2^63, -2^63, 2^64, 1.8e19, -1e19 }'",
    'awk \'BEGIN { x = 2^63 ""; y = 1e19 ""; z = 2^64 ""; print x, y, z }\'',
    "awk 'BEGIN { print 1e300 * 1e300, -1e300 * 1e300 }'",
    "awk 'BEGIN { print length(1/3), length(100) }'",
    'awk \'BEGIN { print index("abc",""), index("",""), int(-0.5), -0.5 "" }\'',
  ])("converts numbers: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk '{print $1, ($1 < 5), ($1 == 10), ($1 < \"5\")}' n.txt",
    "awk '{print ($1 > 5)}' n.txt",
    "echo '10 9' | awk '{print ($1 > $2), ($1\"\" > $2\"\"), ($1+0 > $2)}'",
    "echo ' 12 ' | awk -F, '{print ($1 == 12), length($1), $1 + 1}'",
    "echo '+5 -.5 .5e1 1e 0x1A inf nan' | awk '{print ($1==5), ($2==-0.5), ($3==5), ($4==1), ($5==0), ($6==0), ($7==0)}'",
    "awk 'BEGIN{print (x == 0), (x == \"\"), (x < 1), length(x); y = x + 0; print y}'",
    "awk 'BEGIN{a = \"10\"; b = 9; print (a < b), (a+0 < b)}'",
    'awk \'BEGIN{print ("a" < "b"), ("B" < "a"), ("" < "a"), ("abc" < "abd"), ("ab" < "abc")}\'',
    "echo '3.0 3' | awk '{print ($1 == $2), ($1 \"\" == $2 \"\")}'",
    'echo \'a b\' | awk \'{ print ($5 == 0), ($5 == ""), (x == 0), (x == ""), ($1 < 10) , ("10" < 9), ($3 "" == 0)}\'',
    'echo \'10 9 abc 1e2 0x10 .5 +3 -\' | awk \'{ print ($1 > $2), ($1 > "9"), ($3 > 5), ($4 == 100), ($5 == 16), ($6 == 0.5), ($7 == 3), ($8 == 0), ($8 < 1); print !$8, !$2, !"0", !0, !"", !x }\'',
  ])("compares strnums: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'awk \'BEGIN{a[1]; a["x"]; a[2.5]; print length(a); if (1 in a) print "in1"; if (("x") in a) print "inx"; if (!(3 in a)) print "no3"}\'',
    "awk 'BEGIN{a[1,2]=3; for (k in a) {split(k, p, SUBSEP); print p[1], p[2]}; if ((1,2) in a) print \"yes\"}'",
    'awk \'BEGIN{a["x"]=1; a["y"]=2; delete a["x"]; for (k in a) print k; delete a; print length(a)}\'',
    "awk 'BEGIN{n = split(\"c b a\", arr); for (k in arr) print k, arr[k]}' | sort",
    'awk \'BEGIN{print ENVIRON["LC_ALL"], ("TZ" in ENVIRON), ("NOPE" in ENVIRON)}\'',
    "awk '{c[$1]++} END{for (w in c) print w, c[w]}' f.txt | sort",
    'awk \'BEGIN{a[10];a[9];a[2];a["b"];a["a"];a[-1];a[1.5];a["B"];a[""]; for(k in a) printf "[%s]\\n", k}\' | sort',
    "awk 'BEGIN{x[1]=1; x[2]=2; x[3]=3; delete x[2]; for (k in x) print k, x[k]}' | sort",
    'awk \'BEGIN{SUBSEP=":"; a["p","q"]; for (k in a) print k}\'',
    'awk \'BEGIN{a["k"]; for (k in a) { delete a; a["m"]; a["n"]; printf "%s,", k }; print length(a)}\'',
    'awk \'BEGIN{n=split("a b c d e f g h i j k l m n o p", a); a["z"]; for (k in a) print k}\' | sort',
    "seq 1 200 | awk '{a[$1]} END{for (k in a) print k}' | sort -n",
    "seq 1 1000 | awk '{a[$1 * 3] = NR} END{for (k in a) print k, a[k]; print length(a)}' | sort -n",
    "seq 1 50 | awk '{a[\"k\" $1]} END{for (k in a) print k}' | sort",
    "awk 'BEGIN { a[2^31]; a[2^53]; a[1e30]; a[-3]; a[0.1]; for (k in a) print k }' | sort",
    "awk 'BEGIN { CONVFMT = \"%.2g\"; a[0.1234] = 1; for (k in a) print k }'",
    'awk \'BEGIN { x["a"] = 1; delete x["b"]; print length(x) }\'',
    'awk \'BEGIN { n = split("a b", arr); arr[5] = "e"; for (k in arr) print k, arr[k] }\' | sort',
    "awk 'BEGIN { n = split(\"a b\", arr); delete arr[1]; for (k in arr) print k, arr[k] }'",
    'awk \'BEGIN { n = split("a b c", arr); print (2 in arr), ("2" in arr), (4 in arr); for (k in arr) print k }\' | sort',
    'awk \'BEGIN { a["x"]; print "x" in a, ("y" in a) }\'',
  ])("keeps arrays: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk 'BEGIN{print length(\"hello\"), length(12345), length(), length}'",
    "echo 'abc def' | awk '{print length, length($2)}'",
    'awk \'BEGIN{print substr("hello", 2, 3), substr("hello", 0, 2), substr("hello", -1, 3), substr("hello", 4), substr("hello", 1.5, 2.3), substr("hello", 9) "|", substr("", 1) "|"}\'',
    'awk \'BEGIN { print substr("hello", 2^40) "|", substr("hello", 2, -1) "|" }\'',
    'awk \'BEGIN{print index("hello", "ll"), index("hello", "z"), toupper("abc\\351x"), tolower("ABC Def")}\'',
    "awk 'BEGIN{print length(\"h\\303\\251llo\")}'",
    'awk \'BEGIN{print match("foobar", /o+/), RSTART, RLENGTH; print match("x", /z/), RSTART, RLENGTH; print match("ab", /a|ab/), RLENGTH}\'',
    'awk \'BEGIN{s = "hello world"; n = sub(/o/, "0", s); print n, s; n = gsub(/o/, "0", s); print n, s}\'',
    'awk \'BEGIN{s = "aaa"; print gsub(/a*/, "X", s), s; t = "abc"; print gsub(//, "-", t), t; u = "ab"; print gsub(/x*/, "-", u), u}\'',
    'awk \'BEGIN{s = "hello"; gsub(/l/, "[&]", s); print s; s = "hello"; gsub(/l/, "\\\\&", s); print s; s = "hello"; gsub(/l/, "\\\\\\\\&", s); print s}\'',
    'awk \'BEGIN{s = "a.b.c"; gsub(".", "x", s); print s; s = "a.b.c"; gsub(/\\./, "-", s); print s; s="aaa"; gsub(/^a/, "X", s); print s}\'',
    'awk \'BEGIN{s = "abab"; gsub(/b$/, "X", s); print s; s = "abc"; sub(/b|$/, "X", s); print s; s = "x"; print sub(/y/, "z", s), s}\'',
    "echo 'foo bar foo' | awk '{sub(/foo/, \"baz\"); print; gsub(/o/, \"0\", $3); print; print NF}'",
    "echo 'a-b-c' | awk '{n = gsub(\"-\", \" \"); print n, NF, $2}'",
    'awk \'BEGIN{a["k"] = "xyx"; gsub(/x/, "_", a["k"]); print a["k"]}\'',
    'awk \'BEGIN{n = split("a:b:c", arr, ":"); print n, arr[1], arr[3]; n = split("a1b22c", q, /[0-9]+/); print n, q[1], q[2], q[3]; n = split("", e); print n, length(e)}\'',
    'awk \'BEGIN{n = split("abc", c, ""); print n, c[1], c[3]; n = split("  a  b  ", d); print n, d[1] d[2]; n = split("a.b", e, "."); print n}\'',
    'awk \'BEGIN{n = split(":a::b:", e, ":"); print n, e[1] "|" e[2] "|" e[3] "|" e[5]}\'',
    "awk 'BEGIN{n = split(\"3 4\", v); print v[1] + v[2], (v[1] < v[2]), (v[1] < 10)}'",
    'awk \'BEGIN{s = sprintf("%s=%d", "x", 42); print s, length(s)}\'',
    'awk \'BEGIN { print fflush(), fflush("x"), fflush("/dev/stdout") }\'',
  ])("runs string builtins: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk '/beta/,/gamma/' f.txt",
    "awk 'NR==2,NR==3 {print NR, $1}' f.txt",
    "awk '/alpha/,/alpha/ {print \"r:\" $0}' f.txt",
    "awk '$2 > 8' f.txt",
    "awk 'NR % 2' f.txt",
    "awk '$1 ~ /^a/ {print $2} $1 !~ /a$/ {print \"no\", $1}' f.txt",
    "awk '$1 ~ \"mm\" {print}' f.txt",
    "awk 'BEGIN{r = \"^b\"} $0 ~ r' f.txt",
    "awk 'END{print NR, $0, NF}' f.txt",
    'awk \'BEGIN{print "b"} END{print "e"}\' g.txt',
    "awk 'BEGIN{print \"only\"}' nosuch",
    'awk \'BEGIN{print "one"} BEGIN{print "two"} END{print "three"} END{print "four"}\' g.txt',
    "awk '{ if (NR == 2) next; print }' g.txt",
    "awk 'FNR == 2 { nextfile } { print FILENAME, $0 }' g.txt h.txt",
    'awk \'{ if ($2 > 8) print "big", $1; else print "small", $1 }\' f.txt',
    'awk \'{ if ($2 > 8) { print "big" } else if ($2 > 6) print "mid"; else { print "small" } }\' f.txt',
    'awk \'BEGIN { a["x"]; a["y"]; for (k in a) { if (k == "x") continue; print k } }\'',
    "awk 'BEGIN { split(\"a b c\", a); for (k in a) { n++; break } print n }'",
    "awk 'BEGIN { if (1) }'",
    "awk 'BEGIN{x=1;;;}'",
  ])("selects records by pattern: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk 'BEGIN { exit 3 } END { print \"end\" }'",
    'awk \'BEGIN { exit } END { print "end"; exit 4; print "no" }\'',
    "awk '{ print; exit 5 } END { print \"end\", NR }' g.txt",
    "awk 'NR==2 { exit } { print } END { print \"done\" }' g.txt",
    "awk 'BEGIN { exit -1 }'",
    "awk 'BEGIN { exit 256 + 7 }'",
    'awk \'function quit() { exit 7 } BEGIN { quit(); print "not" } END { print "end" }\'',
  ])("exits: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk 'function f(x) { return x * 2 } BEGIN { print f(3), f(\"4\"), f() }'",
    "awk 'function max(a, b) { return a > b ? a : b } { m = max(m, $2) } END { print m }' f.txt",
    'awk \'function fill(arr, n) { for (k in arr) delete arr[k]; arr["n"] = n } BEGIN { fill(a, 5); print a["n"] }\'',
    "awk 'function g(a) { a[1] = \"set\" } BEGIN { g(x); print x[1] }'",
    'awk \'function h(s,   local) { local = s "!"; return local } BEGIN { print h("hi"), local "|" }\'',
    "awk 'function p(x) { print \"in p\", x } BEGIN { p(1); p(2) }'",
    'awk \'function early(x) { if (x) return "yes"; return "no" } BEGIN { print early(1), early(0) }\'',
    "awk 'function outer(x) { return inner(x) + 1 } function inner(y) { return y * 10 } BEGIN { print outer(2) }'",
    "awk 'function mod(v) { v = 5; return v } BEGIN { x = 1; mod(x); print x }'",
    "awk 'function cnt(a,  k, n) { for (k in a) n++; return n } BEGIN { z[1]; z[2]; print cnt(z) }'",
    "awk 'function nr() { return NR } { print nr() }' g.txt",
    "awk 'function f(a) { return length(a) } BEGIN { q[1]; q[2]; print f(q) }'",
    "awk 'function local(n,  t) { t[n] = n; return length(t) } BEGIN { print local(1), local(2) }'",
  ])("calls functions: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'awk \'BEGIN{RS=""}{print NR": "$0"|"NF; print $3}\' para.txt',
    'awk \'BEGIN{RS=""; FS=","}{print NF": "$1}\' para.txt',
    'awk -v RS= \'{print NR"["$0"]"}\' para.txt',
    'printf \'a\\nb\\n\' | awk \'BEGIN{RS=""}{print NR"["$0"]"}\'',
    'printf \'\\n\\n\\na\\nb\\n\\n\\nc\' | awk \'BEGIN{RS=""}{print NR"["$0"]"}\'',
    'printf \'a,b,c\' | awk \'BEGIN{RS=","}{print NR"["$0"]"}\'',
    'printf \'a,b,c,\\n\' | awk \'BEGIN{RS=","}{print NR"["$0"]"}\'',
    'printf \'a\\n\\nb\' | awk \'BEGIN{RS="\\n+"}{print NR"["$0"]"}\'',
    "printf 'a1b22c' | awk -v RS='[0-9]*' '{print NR\"[\"$0\"]\"}'",
    "printf 'a|b' | awk -v RS='|' '{print NR\"[\"$0\"]\"}'",
    "printf 'one two  three\\n' | awk -v RS=' ' '{print NR\"[\"$0\"]\"}'",
    "printf 'aXYbXYc' | awk -v RS=XY '{print NR\"[\"$0\"]\"}'",
    'awk \'{print NR"["$0"]"}\' h.txt',
    "printf 'a b\\n' | awk 'BEGIN{ORS=\"|\"; OFS=\"-\"}{print $1, $2}'",
    "awk -v 'ORS=\\n\\n' '{print}' g.txt",
    "printf 'x\\n' | awk '{ RS = \",\"; print } END { print NR }'",
    'printf \'a,b\\nc,d\\n\' | awk \'NR == 1 { RS = "," } { print NR"["$0"]" }\'',
  ])("reads records: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'awk \'BEGIN{print ("ab" ~ "a^b"), ("a^b" ~ /a\\^b/), ("abc" ~ /a.c/), ("a\\nc" ~ /a.c/), ("]" ~ /[\\]]/), ("a" ~ /[^]a]/), ("-" ~ /[a-]/), ("b" ~ /[[:alpha:]]/), ("1" ~ /[^[:digit:]]/)}\'',
    'awk \'BEGIN{print ("ab" ~ /a$b/), ("a$" ~ /a\\$/), ("a" ~ /a$$/), match("abc", /$/), RSTART, RLENGTH, match("abc", /^/), RSTART, RLENGTH}\'',
    'awk \'BEGIN{print ("a.b" ~ "a\\.b"), ("axb" ~ "a\\.b"), ("a+b" ~ "a\\\\+b"), ("\\\\" ~ /\\\\/), ("a" ~ /\\a/), ("\\t" ~ /\\t/), ("d" ~ /\\d/), ("y" ~ /\\y/)}\'',
    'awk \'BEGIN{print ("aXb" ~ /a[[:upper:][:digit:]]b/), ("a1b" ~ /a[[:upper:][:digit:]]b/), ("a)" ~ /a)/), ("{" ~ /{/), match("aaa", /a{,2}/), RLENGTH}\'',
    'awk \'BEGIN{print match("xabcabc", /(abc)+/), RSTART, RLENGTH; print match("aaa", /a{2,}/), RLENGTH; print match("ab", /a{0}b/), RLENGTH; print match("abbb", /ab{1,2}/), RLENGTH}\'',
    'awk \'BEGIN{print match("foo bar", /(o|oo)+ /), RLENGTH; print match("xyz", /y?/), RSTART, RLENGTH; print match("abcd", /b*c/), RSTART, RLENGTH}\'',
    'awk \'BEGIN{print ("A" ~ /[a-z]/), ("\\351" ~ /^.$/), ("a-z" ~ /[z-a]/), ("\\t" ~ /[[:space:]]/), (" " ~ /[[:blank:]]/)}\'',
    "awk '/^[a-g]/ {print $1}' f.txt",
    "awk '$1 ~ /^(alpha|gamma)$/' f.txt",
    "awk '$0 ~ /\\/bin\\/(ba)?sh$/ {print $1}' p.txt",
    "awk 'BEGIN{print \"a\" ~ /+a/}'",
    "awk 'BEGIN{print \"a\" ~ /^*a/}'",
    "awk 'BEGIN{print \"a\" ~ /a(/}'",
    'awk \'BEGIN{r="("; print "a" ~ r}\'',
    "awk 'BEGIN{print \"a\" ~ /(|x)/}'",
    "awk 'BEGIN{print \"a\" ~ /[[:foo:]]/}'",
  ])("matches mawk's regular expressions: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'awk \'BEGIN { x = "\\q\\t\\101\\/|\\"\\\\" ; print x}\'',
    'awk \'BEGIN { print "a" "b" 1 + 2 "c" }\'',
    "awk 'BEGIN { print 1 \" \" -1, 2 -1, 1 - -1 }'",
    "awk 'BEGIN { x = 5; print x++ + ++x, x-- - --x, x }'",
    'awk \'BEGIN { print 1 < 2 ? "y" : "n", (2 < 1) ? "y" : "n" }\'',
    "awk 'BEGIN { x = y = 3; print x, y; x += y -= 1; print x, y; x *= 2; x /= 4; x %= 2; x ^= 3; print x }'",
    'awk \'BEGIN { print !x, !!x, -"3", +"4a", !"0" }\'',
    'awk \'BEGIN { print 10 " " 2 * 3 " " 2 ^ 2 ^ 3 }\'',
    "awk 'BEGIN{print length length}'",
    "awk '# comment\nBEGIN { print \"c\" } # trailing\n'",
    "awk '\nBEGIN {\n  x = 1\n  y = 2\n}\n{ print x + y\n}\nEND { print \"done\" }' g.txt",
    'awk \'BEGIN { a = 1 ; if (a) print "t"\nelse print "f" }\'',
    'awk \'BEGIN { if (0)\nprint "t"\nelse\nprint "f" }\'',
    "awk 'BEGIN { x = 1 \\\n+ 2; print x }'",
    "awk 'BEGIN { print 1,\n2 }'",
    "awk 'BEGIN { print (1 &&\n0) || \n1 }'",
    "awk 'function f(a)\n{ return a + 1 }\nBEGIN { print f(1) }'",
    "awk 'BEGIN { split(\"a\", arr); for (k in arr)\nprint k }'",
    "awk 'NR == 1\nNR == 3' g.txt",
  ])("parses expressions and layout: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "awk 'BEGIN{x = 1 & 2}'",
    "awk 'BEGIN{x = \"abc'",
    "awk 'BEGIN{print 1'",
    "awk '{print $1.5}'",
    "awk 'BEGIN { f(1) } function f(a) { return a } function f(b) {}'",
    "awk 'BEGIN'",
    "awk 'BEGIN{print 1 ++ 2}'",
    "awk 'BEGIN { for (k in 5) print }'",
    "awk 'function f(a,a){}'",
    "awk 'BEGIN{@}'",
    "awk 'BEGIN{x=}'",
    "awk 'BEGIN { print foo(1) }'",
    "awk 'BEGIN { next }'",
    "awk 'BEGIN { return 1 }'",
    "awk 'BEGIN { x = 1; x[1] = 2 }'",
    "awk 'BEGIN { a[1] = 1; a = 2 }'",
    "awk 'BEGIN { break }'",
    "awk 'BEGIN { printf }'",
    "awk 'BEGIN { print substr(\"a\") }'",
    'awk \'BEGIN { print index("a", "b", "c") }\'',
    "awk 'BEGIN { print 2 ** 3 }'",
    "awk -f bad.awk",
    "awk -f nosuch.awk",
    "awk '{ print $-1 }' g.txt",
    "awk -F",
    "awk -x 'BEGIN{}'",
    "awk -v 'bad' 'BEGIN{}'",
    "awk '{print}' .",
  ])("reports mawk's diagnostics: %j", async (source) => {
    await compare(source);
  });
});
