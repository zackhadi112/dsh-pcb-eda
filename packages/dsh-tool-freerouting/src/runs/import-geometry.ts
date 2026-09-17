import type { UpstreamImportGeometry } from '../proxy/kicad-upstream-interface.js';

export type GeometryLevel = 'ok' | 'reject' | 'unknown' | 'warn';

export interface GeometryVerdict {
  checked: number;
  level: GeometryLevel;
  /** Why the geometry is suspicious; `undefined` when nothing is wrong. */
  message?: string;
  outside: number;
}

/**
 * Once this share of the imported items escaped the board outline, the session as a
 * whole is considered misplaced and is rolled back instead of only warned about.
 */
const REJECT_OUTSIDE_RATIO = 0.5;

/**
 * Turn the Bridge's post-import geometry report into a run verdict.
 *
 * The Bridge owns the measurement (it compares the imported tracks against
 * `GetBoardEdgesBoundingBox` in pcbnew); this module only decides what the run should
 * do about it, so the judgement stays testable without KiCad:
 * - `reject`: the session landed outside the outline. The classic cause is a KiCad
 *   plugin that does not flip the Specctra Y axis (Y-up) to KiCad's (Y-down), which
 *   mirrors the whole route about y=0 — reported by the Bridge as `mirrored`.
 * - `warn`: a few tracks stick out, which is usually a real board-edge/keepout issue
 *   worth showing but not worth discarding the whole run.
 * - `unknown`: the Bridge could not check (no outline, or an older plugin without the
 *   report). Treated as pass-through so an older KiCad plugin never breaks a run.
 */
export function assessImportGeometry(
  geometry: UpstreamImportGeometry | undefined,
): GeometryVerdict {
  const checked = geometry?.checked ?? 0;
  const outside = geometry?.outside ?? 0;
  if (checked === 0) {
    return { checked, level: 'unknown', outside: 0 };
  }
  if (outside === 0) {
    return { checked, level: 'ok', outside: 0 };
  }

  const mirrored = geometry?.mirrored === true;
  if (mirrored || outside / checked >= REJECT_OUTSIDE_RATIO) {
    return {
      checked,
      level: 'reject',
      message: mirrored
        ? `导入的 ${outside}/${checked} 条走线落在板框外，且整体正好是板框关于 Y 轴的镜像：KiCad 侧导入 SES 时没有对齐 Specctra 坐标系（通常是 KiCad 里的 FreeRouting 插件版本过旧）`
        : `导入的 ${outside}/${checked} 条走线落在板框外：布线结果与当前板子不匹配（板框可能在布线途中被修改，或导入到了另一块板子）`,
      outside,
    };
  }
  return {
    checked,
    level: 'warn',
    message: `有 ${outside}/${checked} 条走线超出板框，请在 KiCad 中检查板框与禁止布线区`,
    outside,
  };
}
