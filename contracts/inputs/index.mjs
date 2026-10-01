// External inputs contract. Every bench module is called as
//   run({ skylensDir, outDir, commit, inputs })
// `inputs` (all optional keys; a module that needs one and finds it missing MUST throw, never synthesize):
//   inputs.pointsPath     string  original point cloud (PLY) used by ref_images
//   inputs.wsRecording    string  JSON Lines, one frame per line:
//                                 {"t_ms": number (relative, >=0), "dir":"rx"|"tx", "bytes": int>=0,
//                                  "kind": string, "segment": int>=0 (rx point frames only), "level": 0..3}
//   inputs.towerRecording string  JSON Lines, see tower_bytes
//   inputs.distDir        string  already built skylens dist (skips building)
//   inputs.anchor         {lat:number, lon:number, alt:number}  GeoAnchor declared by the operator for the viewpoints; compared only with viewpoints.json anchor, the point cloud is not checked
// Default skylens layout: assets at <skylensDir>/res/static/demo/segments/seg<N>_step<5 digits>.ply
//   (step 00250/01000/03500/07000 = level 0..3).
export const STEP_LEVEL = { 250: 0, 1000: 1, 3500: 2, 7000: 3 };

export function requireInput(inputs, key) {
  const v = inputs?.[key];
  if (v === undefined || v === null || v === '') throw new Error(`input missing: ${key}`);
  return v;
}
