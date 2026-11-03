/**
 * Evaluates LightGBM trees exported by smard-forecast (scripts/phase4_export.py)
 * as parallel arrays. Follows LightGBM's NumericalDecision exactly: NaN counts
 * as 0 unless the split handles NaN itself; missing values (zero or NaN,
 * depending on the split) go to the default side; otherwise x <= threshold
 * goes left. Children below 0 are leaves (-1 = first leaf).
 */

export interface CompactTree {
  f: number[]; // split feature index
  t: number[]; // threshold
  m: number[]; // missing type: 0 none, 1 zero, 2 NaN
  d: number[]; // 1 = missing goes left
  l: number[];
  r: number[];
  v: number[]; // leaf values
}

export interface CompactModel {
  merkmale: string[];
  baeume: CompactTree[];
}

const ZERO_THRESHOLD = 1e-35;

export function predictTree(tree: CompactTree, x: ArrayLike<number>): number {
  if (tree.f.length === 0) return tree.v[0]!;
  let node = 0;
  for (;;) {
    let value = x[tree.f[node]!]!;
    const missingType = tree.m[node]!;
    if (Number.isNaN(value) && missingType !== 2) value = 0;
    let left: boolean;
    if ((missingType === 1 && Math.abs(value) <= ZERO_THRESHOLD) || (missingType === 2 && Number.isNaN(value))) {
      left = tree.d[node] === 1;
    } else {
      left = value <= tree.t[node]!;
    }
    const next = left ? tree.l[node]! : tree.r[node]!;
    if (next < 0) return tree.v[-next - 1]!;
    node = next;
  }
}

export function predictModel(model: CompactModel, x: ArrayLike<number>): number {
  let sum = 0;
  for (const tree of model.baeume) sum += predictTree(tree, x);
  return sum;
}
