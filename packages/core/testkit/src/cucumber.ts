// BDD test primitives — import from @dpopsuev/alef-testkit/bdd.
// Kept separate from the main index so @amiceli/vitest-cucumber (devDependency)
// is never loaded by production code or the runner binary.
export { defineFeature } from "@amiceli/vitest-cucumber";
