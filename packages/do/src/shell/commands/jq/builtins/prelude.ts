// The jq-coded builtins, taken from jq 1.8.1's src/builtin.jq (MIT) for the
// admitted surface. Running jq's own definitions keeps their output order and
// error texts exact. Recursive definitions (recurse, _flatten) are natives
// here because user-level recursion is refused.

export const PRELUDE = `
def error(msg): msg|error;
def map(f): [.[] | f];
def select(f): if f then . else empty end;
def sort_by(f): _sort_by_impl(map([f]));
def group_by(f): _group_by_impl(map([f]));
def unique_by(f): _unique_by_impl(map([f]));
def max_by(f): _max_by_impl(map([f]));
def min_by(f): _min_by_impl(map([f]));
def add(f): reduce f as $x (null; . + $x);
def add: add(.[]);
def del(f): delpaths([path(f)]);
def abs: if . < 0 then - . else . end;
def map_values(f): .[] |= f;
def to_entries: [keys_unsorted[] as $k | {key: $k, value: .[$k]}];
def from_entries: map({(.key // .Key // .name // .Name): (if has("value") then .value else .Value end)}) | add | .//={};
def with_entries(f): to_entries | map(f) | from_entries;
def reverse: [.[length - 1 - range(0;length)]];
def indices($i): if type == "array" and ($i|type) == "array" then .[$i]
  elif type == "array" then .[[$i]]
  elif type == "string" and ($i|type) == "string" then _strindices($i)
  else .[$i] end;
def index($i):   indices($i) | .[0];
def rindex($i):  indices($i) | .[-1:][0];
def paths: path(recurse)|select(length > 0);
def paths(node_filter): path(recurse|select(node_filter))|select(length > 0);
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type|. == "array" or . == "object");
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def nulls: select(. == null);
def values: select(. != null);
def scalars: select(type|. != "array" and . != "object");
def join($x): reduce .[] as $i (null;
            (if .==null then "" else .+$x end) +
            ($i | if type=="boolean" or type=="number" then tostring else .//"" end)
        ) // "";
def flatten($x): if $x < 0 then error("flatten depth must not be negative") else _flatten($x) end;
def flatten: _flatten(-1);
def range($x): range(0;$x);
def fromdateiso8601: strptime("%Y-%m-%dT%H:%M:%SZ")|mktime;
def todateiso8601: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdate: fromdateiso8601;
def todate: todateiso8601;
def ltrimstr($left): if startswith($left) then .[$left | length:] end;
def rtrimstr($right): if endswith($right) then .[:$right | -length] end;
def trimstr($val): ltrimstr($val) | rtrimstr($val);
def match(re; mode): _match_impl(re; mode; false)|.[];
def match($val): ($val|type) as $vt | if $vt == "string" then match($val; null)
   elif $vt == "array" and ($val | length) > 1 then match($val[0]; $val[1])
   elif $vt == "array" and ($val | length) > 0 then match($val[0]; null)
   else error( $vt + " not a string or array") end;
def test(re; mode): _match_impl(re; mode; true);
def test($val): ($val|type) as $vt | if $vt == "string" then test($val; null)
   elif $vt == "array" and ($val | length) > 1 then test($val[0]; $val[1])
   elif $vt == "array" and ($val | length) > 0 then test($val[0]; null)
   else error( $vt + " not a string or array") end;
def capture(re; mods): match(re; mods) | reduce ( .captures | .[] | select(.name != null) | { (.name) : .string } ) as $pair ({}; . + $pair);
def capture($val): ($val|type) as $vt | if $vt == "string" then capture($val; null)
   elif $vt == "array" and ($val | length) > 1 then capture($val[0]; $val[1])
   elif $vt == "array" and ($val | length) > 0 then capture($val[0]; null)
   else error( $vt + " not a string or array") end;
def scan($re; $flags):
  match($re; "g" + $flags)
    | if (.captures|length > 0)
      then [ .captures | .[] | .string ]
      else .string
      end;
def scan($re): scan($re; null);
def splits($re; $flags):
  .[foreach (match($re; $flags+"g"), null) as {$offset, $length}
      (null; {start: .next, end: $offset, next: ($offset+$length)})];
def splits($re): splits($re; null);
def split($re; $flags): [ splits($re; $flags) ];
def sub($re; s; $flags):
   . as $in
   | (reduce match($re; $flags) as $edit
        ({result: [], previous: 0};
            $in[ .previous: ($edit | .offset) ] as $gap
            | [reduce ( $edit | .captures | .[] | select(.name != null) | { (.name) : .string } ) as $pair
                 ({}; . + $pair) | s ] as $inserts
            | reduce range(0; $inserts|length) as $ix (.; .result[$ix] += $gap + $inserts[$ix])
            | .previous = ($edit | .offset + .length ) )
          | .result[] + $in[.previous:] )
      // $in;
def sub($re; s): sub($re; s; "");
def gsub($re; s; flags): sub($re; s; flags + "g");
def gsub($re; s): sub($re; s; "g");
def nth($n; g):
  if $n < 0 then error("nth doesn't support negative indices")
  else first(skip($n; g)) end;
def first: .[0];
def last: .[-1];
def nth($n): .[$n];
def isempty(g): first((g|false), true);
def all(generator; condition): isempty(generator|condition and empty);
def any(generator; condition): isempty(generator|condition or empty)|not;
def all(condition): all(.[]; condition);
def any(condition): any(.[]; condition);
def all: all(.[]; .);
def any: any(.[]; .);
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def ascii_downcase:
  explode | map( if 65 <= . and . <= 90 then . + 32  else . end) | implode;
def ascii_upcase:
  explode | map( if 97 <= . and . <= 122 then . - 32  else . end) | implode;
def debug(msgs): (msgs | debug | empty), .;
`;

/** jq 1.8.1 builtins this shell declines, by name/arity. */
export const REFUSED_BUILTINS = [
  "IN/1 IN/2 INDEX/1 INDEX/2 JOIN/2 JOIN/3 JOIN/4 acos/0 acosh/0 asin/0 asinh/0 atan/0 atan2/2",
  "atanh/0 bsearch/1 builtins/0 cbrt/0 combinations/0 combinations/1 copysign/2 cos/0 cosh/0",
  "drem/2 erf/0 erfc/0 exp/0 exp10/0 exp2/0 expm1/0 fdim/2 finites/0 fma/3 fmax/2 fmin/2 fmod/2",
  "format/1 frexp/0 fromstream/1 gamma/0 get_jq_origin/0 get_prog_origin/0 get_search_list/0",
  "halt/0 halt_error/0 halt_error/1 hypot/2 input_line_number/0 isfinite/0 isnormal/0",
  "j0/0 j1/0 jn/2 ldexp/2 lgamma/0 lgamma_r/0 localtime/0 log10/0 log1p/0 log2/0 logb/0",
  "modf/0 modulemeta/0 nearbyint/0 nextafter/2 nexttoward/2 normals/0 pick/1 remainder/2 repeat/1",
  "rint/0 scalb/2 scalbln/2 significand/0 sin/0 sinh/0 strflocaltime/1 tan/0 tanh/0 tgamma/0",
  "toboolean/0 tostream/0 transpose/0 trunc/0 truncate_stream/1 until/2 walk/1 while/2 y0/0",
  "y1/0 yn/2",
]
  .join(" ")
  .split(" ");
