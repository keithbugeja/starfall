// Generated systems: a World built from a SystemRecipe rather than the home system's authored layout.
// Milestone one of the sector slice: the recipe schema exists, the generator arrives in milestone two.
import type { SystemRecipe } from '../sector/sector';
import type { World } from '../sim/world';

export function generateFromRecipe(r: SystemRecipe): World {
  throw new Error(`generated systems are not built yet: ${r.id}`);
}
