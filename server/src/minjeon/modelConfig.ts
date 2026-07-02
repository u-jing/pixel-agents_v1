export interface AgentConfig {
  name: string;
  model: string;
  role: string;
}

export interface StageConfig {
  id: string;
  label: string;
  agents: AgentConfig[];
}

export const STAGES: StageConfig[] = [
  {
    id: 'classify',
    label: '민원분류',
    agents: [
      { name: '분류-A', model: 'google/gemma-4-31b-it', role: '민원 유형 분류 전문가' },
      { name: '분류-B', model: 'microsoft/phi-4', role: '민원 유형 분류 전문가' },
      { name: '분류-C', model: 'mistralai/mistral-small-3.2-24b-instruct', role: '민원 유형 분류 전문가' },
    ],
  },
  {
    id: 'search',
    label: '검색',
    agents: [{ name: '검색', model: '(로컬)', role: '관련 정보 검색' }],
  },
  {
    id: 'write',
    label: '작성',
    agents: [
      { name: '공식 초안', model: 'nvidia/nemotron-3-super-120b-a12b', role: '공식적인 민원 초안 작성' },
      { name: '문제 강조', model: 'meta-llama/llama-4-maverick', role: '문제점 강조 초안 작성' },
      { name: '간결 초안', model: 'qwen/qwen3.5-plus-02-15', role: '간결한 핵심 초안 작성' },
    ],
  },
  {
    id: 'review',
    label: '검수',
    agents: [
      { name: '정중성 검수', model: 'google/gemini-2.5-flash', role: '어조 정중성 검토' },
      { name: '개인정보 검수', model: 'microsoft/phi-4', role: '개인정보 노출 여부 검토' },
      { name: '요청 명확성', model: 'mistralai/mistral-small-3.2-24b-instruct', role: '요청 사항 명확성 검토' },
      { name: '과장 표현', model: 'google/gemma-4-31b-it', role: '과장/감정적 표현 검토' },
    ],
  },
  {
    id: 'integrate',
    label: '최종 통합',
    agents: [
      { name: '통합', model: 'nvidia/nemotron-3-super-120b-a12b', role: '최종 민원서 통합 작성' },
    ],
  },
];
