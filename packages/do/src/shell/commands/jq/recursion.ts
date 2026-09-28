// Deep values without deep JavaScript stacks. jq accepts JSON nested 10,000
// levels deep, and a recursive walk over it overflows V8's stack. A walk is
// written as a generator that yields each sub-call and receives its result;
// `trampoline` runs the calls on an explicit stack.

export type Recursion<T> = Generator<Recursion<T>, T, T>;

export function trampoline<T>(root: Recursion<T>): T {
  const stack: Recursion<T>[] = [root];
  let input: [] | [T] = [];
  for (;;) {
    const top = stack[stack.length - 1];
    if (top === undefined) throw new Error("trampoline: empty stack");
    const step = top.next(...input);
    if (step.done === true) {
      stack.pop();
      if (stack.length === 0) return step.value;
      input = [step.value];
    } else {
      stack.push(step.value);
      input = [];
    }
  }
}
