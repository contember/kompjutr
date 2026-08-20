// Fetch and rebuild fixtures ahead of a sweep, so the network is never part
// of a measured run and a missing tag fails before the benchmark starts.

import {
  FIXTURE_NAMES,
  FIXTURES,
  isFixtureName,
  prepareFixture,
  trackedEntries,
} from "./fixtures.js";

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : [...FIXTURE_NAMES];
for (const name of names) {
  if (!isFixtureName(name)) throw new Error(`unknown fixture: ${name}`);
  const fixture = FIXTURES[name];
  const started = performance.now();
  const dir = prepareFixture(fixture);
  const tracked = trackedEntries(dir).length;
  process.stdout.write(
    `${name} ${fixture.ref}: ${tracked} tracked files (report says ${fixture.files}) ` +
      `in ${Math.round((performance.now() - started) / 1000)}s\n`,
  );
}
