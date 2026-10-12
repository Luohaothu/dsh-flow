/** Collaboration facts, with native Sessions providing every member conversation. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { FlowMember, FlowTask, FlowTeamSnapshot, FlowTeamState, FlowMemberState, FlowTaskState } from '../types.ts';
import type { TeamObserver } from './observer.ts';

export interface TeamUi {
  observer: TeamObserver;
  openMember(member: FlowMember): void;
  sidebar(member: FlowMember): void;
  main(): void;
  openTeam(): void;
  tab(visible: boolean): void;
}
const TEAM_STATES: Record<FlowTeamState, string> = {running:'进行中',paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已取消'};
const MEMBER_STATES: Record<FlowMemberState, string> = {queued:'等待执行',paused:'暂停调度',idle:'空闲',running:'执行中',closed:'已结束',failed:'失败'};
const TASK_STATES: Record<FlowTaskState, string> = {OPEN:'待完成',SUBMITTED:'待接受',ACCEPTED:'已接受',FAILED:'失败',CANCELLED:'已取消'};
const when = (time: number) => new Date(time).toLocaleString('zh-CN');
const count = (value: number | null) => value === null ? '未提供' : value.toLocaleString('zh-CN');
function person(team: FlowTeamSnapshot, id: string): string {
  return id === team.run.owner_session_id ? '主会话' : team.members.find(member => member.session_id === id)?.name ?? id;
}
export function TeamHeader({ui}: {ui: TeamUi}) {
  const {team, runs, error} = useSyncExternalStore(ui.observer.subscribe, ui.observer.getSnapshot);
  useEffect(() => { ui.tab(runs.length > 0); }, [runs.length, ui]);
  if (!runs.length) return null;
  return <Button size="sm" onClick={ui.openTeam} title={error ?? '查看团队任务与成员'}>团队 · {team ? TEAM_STATES[team.run.state] : '加载中'}</Button>;
}
function MemberList({team, ui}: {team: FlowTeamSnapshot; ui: TeamUi}) {
  return <section aria-label="成员" className="flow-section">
    <h2>成员 <span>{team.members.length}</span></h2>
    <div className="flow-member-grid">
      <article className="flow-member-card"><div className="flow-row"><strong>主会话</strong><Tag>根任务执行者</Tag></div><p>负责最终交付，并根据需要委派和验收成员任务。</p><Button size="sm" onClick={ui.main}>打开主会话</Button></article>
      {team.members.map(member => <article className="flow-member-card" key={member.id} data-member-id={member.id}>
        <div className="flow-row"><strong>{member.name}</strong><Tag>{MEMBER_STATES[member.state]}</Tag></div>
        <p>上级 · {member.parent_id ? person(team, member.parent_id) : '主会话'}</p>
        <p>{team.tasks.find(task => task.id === member.active_task_id)?.title ?? '暂无当前任务'}</p>
        {member.error && <p className="flow-error">{member.error}</p>}
        <div className="flow-row"><Button size="sm" onClick={() => ui.openMember(member)}>打开会话</Button><Button size="sm" onClick={() => ui.sidebar(member)}>侧栏查看</Button></div>
      </article>)}
    </div>
  </section>;
}
function TaskDetails({team, task}: {team: FlowTeamSnapshot; task: FlowTask}) {
  const results = team.results.filter(result => result.task_id === task.id).sort((a,b) => b.created - a.created);
  return <section className="flow-task-details" aria-label="任务详情">
    <div className="flow-row"><h3>{task.title}</h3><Tag>{task.paused ? '暂停调度' : TASK_STATES[task.status]}</Tag></div>
    <p className="flow-prose">{task.objective}</p>
    <dl className="flow-facts"><div><dt>负责</dt><dd>{person(team, task.owner_session_id)}</dd></div><div><dt>执行</dt><dd>{person(team, task.assignee_session_id)}</dd></div><div><dt>版本</dt><dd>{task.version}</dd></div></dl>
    {task.parent_id && <p>上级任务 · {team.tasks.find(parent => parent.id === task.parent_id)?.title ?? task.parent_id}</p>}
    {task.depends_on.length > 0 && <p>依赖 · {task.depends_on.map(id => team.tasks.find(dependency => dependency.id === id)?.title ?? id).join('、')}</p>}
    {task.criteria.length > 0 && <><h4>完成条件</h4><ul>{task.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></>}
    <h4>结果与接受记录</h4>
    {!results.length && <p className="flow-muted">尚未提交结果。</p>}
    {results.map(result => <article className="flow-result" key={result.id} data-result-id={result.id}>
      <div className="flow-row"><strong>{result.id === task.result_id ? '当前结果' : '历史结果'}</strong><Tag>{result.outcome === 'complete' ? '完成' : result.outcome === 'partial' ? '部分完成' : '受阻'}</Tag><span>任务版本 {result.task_version}</span></div>
      <p className="flow-prose">{result.summary}</p>
      <p className="flow-muted">{person(team, result.author_session_id)} · {when(result.created)}{!result.ready ? ' · 尚未就绪' : ''}</p>
      {result.artifacts.length > 0 && <ul aria-label="产物">{result.artifacts.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
      {team.reviews.filter(review => review.result_id === result.id).map(review => <div className="flow-review" key={review.id} data-review-id={review.id}>
        <div className="flow-row"><Tag>{review.accepted ? '接受' : '需修改'}</Tag><span>{person(team, review.reviewer_session_id)} · {when(review.created)}</span></div>
        <p className="flow-prose">{review.notes}</p>
        {review.evidence.length > 0 && <ul aria-label="接受依据">{review.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}
      </div>)}
    </article>)}
  </section>;
}
function Tasks({team}: {team: FlowTeamSnapshot}) {
  const [selectedId, select] = useState(team.run.root_task_id);
  const selected = team.tasks.find(task => task.id === selectedId) ?? team.tasks[0];
  return <section className="flow-section" aria-label="任务与结果"><h2>任务与结果 <span>{team.tasks.length}</span></h2>
    <div className="flow-task-layout"><nav className="flow-task-list" aria-label="任务列表">{team.tasks.map(task => <button type="button" className="flow-task-button" key={task.id} onClick={() => select(task.id)} aria-current={selected?.id === task.id ? 'true' : undefined}>
      <span>{task.title}</span><small>{task.paused ? '暂停调度' : TASK_STATES[task.status]} · {person(team, task.assignee_session_id)}</small>
    </button>)}</nav>{selected ? <TaskDetails team={team} task={selected}/> : <p>暂无任务。</p>}</div>
  </section>;
}
export function TeamView({ui}: {ui: TeamUi}) {
  const {runs, team, loading, error, updated} = useSyncExternalStore(ui.observer.subscribe, ui.observer.getSnapshot);
  return <main className="flow-team" aria-label="团队协作">
    <header className="flow-team-heading"><div><span className="flow-eyebrow">团队协作</span><h1>{team?.run.title ?? '智能体团队'}</h1></div><Button size="sm" onClick={() => void ui.observer.refresh()}>刷新</Button></header>
    {error && <p className="flow-error" role="alert">读取失败：{error}。{team ? '下面保留上次成功读取的内容。' : ''}</p>}
    {loading && <p role="status">正在加载团队…</p>}
    {!loading && !team && !error && <p className="flow-empty">在主会话输入 /agent-team 和任务描述，按需委派成员一起完成工作。</p>}
    {runs.length > 1 && <label className="flow-run-select">团队记录 <select value={team?.run.id ?? ''} onChange={event => ui.observer.select(event.currentTarget.value)}>{runs.map(run => <option key={run.id} value={run.id}>{run.title} · {TEAM_STATES[run.state]}</option>)}</select></label>}
    {team && <>
      <div className="flow-summary"><Tag>{TEAM_STATES[team.run.state]}</Tag><span>{team.tasks.filter(task => task.status === 'ACCEPTED').length}/{team.tasks.length} 任务已接受</span><span>成员 {count(team.usage.responses)} 次模型响应</span><span>成员 Token {count(team.usage.total_tokens)}</span></div>
      <details className="flow-objective"><summary>任务目标与运行信息</summary><p className="flow-prose">{team.run.objective}</p><dl className="flow-facts"><div><dt>工作目录</dt><dd>{team.run.workspace}</dd></div><div><dt>创建</dt><dd>{when(team.run.created)}</dd></div>{team.run.deadline && <div><dt>截止</dt><dd>{when(team.run.deadline)}</dd></div>}<div><dt>团队标识</dt><dd><code>{team.run.id}</code></dd></div></dl></details>
      <MemberList team={team} ui={ui}/><Tasks key={team.run.id} team={team}/>
      <section className="flow-section" aria-label="成员消息"><h2>消息 <span>{team.messages.length}</span></h2>{!team.messages.length && <p className="flow-muted">暂无成员消息。</p>}{team.messages.map(message => <article className="flow-message" key={message.id}><div className="flow-row"><strong>{person(team, message.from_session_id)} → {person(team, message.to_session_id)}</strong><Tag>{message.mode === 'request' ? '请求' : '通知'}</Tag><span>{message.state === 'delivered' ? '已送达' : message.state === 'queued' ? '待送达' : '已取消'}</span></div><p className="flow-prose">{message.content}</p><small>{when(message.created)}{message.task_id ? ` · ${team.tasks.find(task => task.id === message.task_id)?.title ?? message.task_id}` : ''}</small></article>)}</section>
      <details className="flow-events"><summary>运行事件 · {team.events.length}</summary>{team.events.map(event => <details key={event.seq}><summary>{event.type} · {when(event.at)}</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>)}</details>
    </>}
    {updated && <p className="flow-updated">最近读取 · {when(updated)}</p>}
  </main>;
}
