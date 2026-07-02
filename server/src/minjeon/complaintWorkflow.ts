import type { SearchResult } from './localSearch.js';
import { searchByComplaintType } from './localSearch.js';
import type { AgentConfig, StageConfig } from './modelConfig.js';
import { STAGES } from './modelConfig.js';
import type { ChatMessage } from './openrouterClient.js';
import { complete } from './openrouterClient.js';

export type SendEvent = (data: Record<string, unknown>) => void;

// ── Helpers ────────────────────────────────────────────────────

function emitStageStart(send: SendEvent, stage: StageConfig): void {
  send({
    type: 'stage_start',
    stageId: stage.id,
    stage: stage.label,
    agents: stage.agents.map((a) => ({ name: a.name, model: a.model })),
  });
}

function emitStageComplete(send: SendEvent, stage: StageConfig, summary: string, extra?: Record<string, unknown>): void {
  send({ type: 'stage_complete', stageId: stage.id, stage: stage.label, summary, ...extra });
}

async function runAgent(
  send: SendEvent,
  stage: StageConfig,
  agent: AgentConfig,
  messages: ChatMessage[],
  fallback: string,
): Promise<string> {
  send({ type: 'agent_start', stageId: stage.id, stage: stage.label, agent: agent.name, model: agent.model });

  const result = await complete(agent.model, messages).catch((err: unknown) => ({
    content: `${fallback}: ${String(err)}`,
    model: agent.model,
  }));

  send({
    type: 'agent_result',
    stageId: stage.id,
    stage: stage.label,
    agent: agent.name,
    model: agent.model,
    result: result.content,
  });

  return result.content;
}

function majorityVote(votes: string[]): string {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote, (counts.get(vote) ?? 0) + 1);
  }
  let best = '기타';
  let bestCount = 0;
  for (const [candidate, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

// ── Stage prompt builders ──────────────────────────────────────

function classifyPrompt(title: string, content: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '당신은 민원 유형을 분류하는 전문가입니다. 민원 내용을 분석하여 다음 유형 중 하나만 정확히 출력하세요: 도로/교통, 환경/소음, 건축/건설, 위생/보건, 복지/사회, 세금/과태료, 기타. 유형 이름만 출력하고 다른 설명은 하지 마세요.',
    },
    { role: 'user', content: `제목: ${title}\n내용: ${content}` },
  ];
}

function writeDraftPrompt(
  agentName: string,
  title: string,
  content: string,
  complaintType: string,
  search: SearchResult,
): ChatMessage[] {
  const systemByAgent: Record<string, string> = {
    '공식 초안': `당신은 공식 행정 민원서 작성 전문가입니다. 격식체(~합니다/~습니다)를 사용하여 공식적이고 정확한 민원 초안을 작성하세요. 담당부서: ${search.department}, 관련법규: ${search.relatedLaws.join(', ')}, 필요서류: ${search.requiredDocuments.join(', ')}`,
    '문제 강조': '당신은 민원 작성 전문가입니다. 문제의 심각성과 불편함을 명확히 강조하는 민원 초안을 작성하세요. 사실에 근거하여 문제의 핵심을 강하게 부각시키세요.',
    '간결 초안': '당신은 민원 작성 전문가입니다. 핵심만 담은 간결하고 명료한 민원 초안을 작성하세요. 불필요한 내용을 제거하고 요점만 전달하세요.',
  };
  return [
    {
      role: 'system',
      content: systemByAgent[agentName] ?? '당신은 민원 작성 전문가입니다. 완성도 높은 민원 초안을 작성하세요.',
    },
    {
      role: 'user',
      content: `민원 제목: ${title}\n민원 유형: ${complaintType}\n담당부서: ${search.department}\n민원 내용:\n${content}\n\n위 내용을 바탕으로 민원 초안을 작성해주세요.`,
    },
  ];
}

function reviewPrompt(agentName: string, draft: string): ChatMessage[] {
  const instructions: Record<string, string> = {
    '정중성 검수': '어조가 정중하고 예의 바른지 검토하세요. 무례하거나 공격적인 표현이 있으면 지적하고 개선 제안을 2-3문장으로 작성하세요.',
    '개인정보 검수': '불필요하게 노출된 개인정보(이름, 주소, 전화번호, 주민번호 등)가 있는지 검토하세요. 문제 있는 부분과 개선 방향을 2-3문장으로 작성하세요.',
    '요청 명확성': '요청 사항이 명확하게 전달되는지 검토하세요. 모호하거나 불명확한 부분과 개선 방향을 2-3문장으로 작성하세요.',
    '과장 표현': '과장되거나 감정적인 표현이 있는지 검토하세요. 객관적 사실에 기반하지 않은 표현과 개선 방향을 2-3문장으로 작성하세요.',
  };
  return [
    {
      role: 'system',
      content: `당신은 민원 초안 검수 전문가입니다. ${instructions[agentName] ?? '민원 초안의 품질을 검토하고 개선 방향을 2-3문장으로 작성하세요.'}`,
    },
    { role: 'user', content: `민원 초안:\n${draft}` },
  ];
}

function integratePrompt(draft: string, reviewSummary: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '당신은 민원 초안 최종 작성 전문가입니다. 초안과 검수 의견을 종합하여 완성도 높은 최종 민원서를 작성하세요. 격식체를 사용하고 수신인, 제목, 본문, 요청사항, 날짜 형식을 갖추세요.',
    },
    {
      role: 'user',
      content: `원본 초안:\n${draft}\n\n검수 의견:\n${reviewSummary}\n\n위 검수 의견을 반영하여 최종 민원서를 완성해주세요.`,
    },
  ];
}

// ── Pipeline ───────────────────────────────────────────────────

export async function runMinjeonPipeline(
  title: string,
  content: string,
  send: SendEvent,
): Promise<void> {
  send({ type: 'pipeline_start', stages: STAGES.map((s) => s.label) });

  // ── Stage 1: 민원분류 (병렬 3 agents) ─────────────────────────
  const classifyStage = STAGES[0]!;
  emitStageStart(send, classifyStage);

  const classifyResults = await Promise.all(
    classifyStage.agents.map((agent) =>
      runAgent(send, classifyStage, agent, classifyPrompt(title, content), '분류 실패'),
    ),
  );

  const complaintType = majorityVote(classifyResults.map((r) => r.trim()));
  emitStageComplete(send, classifyStage, `분류 결과: ${complaintType}`, { category: complaintType });

  // ── Stage 2: 검색 (로컬 지식 베이스) ──────────────────────────
  const searchStage = STAGES[1]!;
  const searchAgent = searchStage.agents[0]!;
  emitStageStart(send, searchStage);

  send({ type: 'agent_start', stageId: searchStage.id, stage: searchStage.label, agent: searchAgent.name, model: searchAgent.model });
  const searchResult = searchByComplaintType(complaintType);
  const searchSummary = `담당부서: ${searchResult.department} | 법규: ${searchResult.relatedLaws.join(', ')} | 서류: ${searchResult.requiredDocuments.join(', ')}`;
  send({ type: 'agent_result', stageId: searchStage.id, stage: searchStage.label, agent: searchAgent.name, model: searchAgent.model, result: searchSummary });

  emitStageComplete(send, searchStage, `담당부서: ${searchResult.department}`);

  // ── Stage 3: 작성 (병렬 3 agents) ─────────────────────────────
  const writeStage = STAGES[2]!;
  emitStageStart(send, writeStage);

  const drafts = await Promise.all(
    writeStage.agents.map((agent) =>
      runAgent(
        send,
        writeStage,
        agent,
        writeDraftPrompt(agent.name, title, content, complaintType, searchResult),
        '초안 작성 실패',
      ),
    ),
  );

  const bestDraft = drafts[0] ?? '';
  emitStageComplete(send, writeStage, `${drafts.length}개 초안 작성 완료`);

  // ── Stage 4: 검수 (병렬 4 agents) ─────────────────────────────
  const reviewStage = STAGES[3]!;
  emitStageStart(send, reviewStage);

  const reviews = await Promise.all(
    reviewStage.agents.map((agent) =>
      runAgent(send, reviewStage, agent, reviewPrompt(agent.name, bestDraft), '검수 실패'),
    ),
  );

  emitStageComplete(send, reviewStage, `${reviews.length}개 항목 검수 완료`);

  // ── Stage 5: 최종 통합 (1 agent) ───────────────────────────────
  const integrateStage = STAGES[4]!;
  const integrateAgent = integrateStage.agents[0]!;
  emitStageStart(send, integrateStage);

  const reviewSummary = reviewStage.agents
    .map((a, i) => `[${a.name}]: ${reviews[i] ?? ''}`)
    .join('\n\n');

  const finalDraft = await runAgent(
    send,
    integrateStage,
    integrateAgent,
    integratePrompt(bestDraft, reviewSummary),
    '최종 통합 실패',
  );

  emitStageComplete(send, integrateStage, '최종 초안 완성');
  send({ type: 'final_draft', draft: finalDraft });
  send({ type: 'pipeline_complete' });
}
