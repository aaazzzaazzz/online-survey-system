// 题库权限（T4 已确认：首期只读共享）。判定集中在此，所有题库/题目接口共用。
// owner = 题库所有者（全部操作）；viewer = 共享用户（查看、复用、使用关系、跨问卷统计）；
// none = 无关用户（对外一律 404，不泄露存在性）。editor 角色首期无授予路径（sharedWith.canEdit 字段预留）。
function getBankAccess(bank, userId) {
  if (!bank) return 'none';
  const uid = String(userId);
  if (bank.ownerId.toHexString() === uid) return 'owner';
  if ((bank.sharedWith || []).some((s) => s.userId.toHexString() === uid)) return 'viewer';
  return 'none';
}

module.exports = { getBankAccess };
