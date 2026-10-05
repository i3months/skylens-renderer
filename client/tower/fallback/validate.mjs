// T15.8 스텁 — 하위 작업이 채운다. 계약: contracts/controlview/fallback.mjs
export { checkDrones, checkDetections, checkPath, checkSize } from '../overlay/validate.mjs';
export const checkFallbackOpts = () => { throw new Error('not implemented'); };
export const checkView = () => { throw new Error('not implemented'); };
export const checkAvailable = () => { throw new Error('not implemented'); };
export const checkEnuRange = () => { throw new Error('not implemented'); };
