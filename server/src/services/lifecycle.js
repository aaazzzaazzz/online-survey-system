// 问卷生命周期：发布状态、主动关闭状态与截止时间三者分离的统一判断。
// - 发布状态：status === 'draft'（未发布）；publishedAt 记录首次发布时间；
// - 主动关闭：status === 'closed'（创建者手动关闭）；closedAt 记录关闭时间；
// - 截止时间：deadline（纯时间维度，独立于 status；过期即拒绝访问与提交，惰性判断无后台任务）。
// 填写开放 = 已发布 && 未手动关闭 && 未过截止时间。
// 注：复制问卷与重新开放属范围外功能，已按需求收敛移除（见 ai-log 第 12 轮）。

function openness(survey, now = new Date()) {
  if (survey.status === 'draft') return { open: false, reason: '问卷未发布' };
  if (survey.status === 'closed') return { open: false, reason: '问卷已关闭' };
  if (survey.deadline && now > survey.deadline) return { open: false, reason: '问卷已截止' };
  return { open: true, reason: '' };
}

// 展示用有效状态：draft / published / closed / expired（已发布但过截止时间）
function effectiveStatus(survey, now = new Date()) {
  if (survey.status === 'draft') return 'draft';
  if (survey.status === 'closed') return 'closed';
  if (survey.deadline && now > survey.deadline) return 'expired';
  return 'published';
}

module.exports = { openness, effectiveStatus };
