export interface SearchResult {
  complaintType: string;
  department: string;
  keywords: string[];
  requiredDocuments: string[];
  relatedLaws: string[];
}

const KNOWLEDGE_BASE: Record<string, Omit<SearchResult, 'complaintType'>> = {
  '도로/교통': {
    department: '도로교통과',
    keywords: ['도로', '교통', '신호등', '과속', '불법주차', '보행로'],
    requiredDocuments: ['민원신청서', '현장사진(선택)'],
    relatedLaws: ['도로법', '도로교통법'],
  },
  '환경/소음': {
    department: '환경과',
    keywords: ['소음', '진동', '악취', '대기오염', '수질오염', '쓰레기'],
    requiredDocuments: ['민원신청서', '소음측정 결과(선택)'],
    relatedLaws: ['소음진동관리법', '대기환경보전법'],
  },
  '건축/건설': {
    department: '건축과',
    keywords: ['건축', '공사', '허가', '불법건축물', '담장', '건물'],
    requiredDocuments: ['민원신청서', '위치도'],
    relatedLaws: ['건축법', '주택법'],
  },
  '위생/보건': {
    department: '위생과',
    keywords: ['위생', '식품', '음식점', '병원', '약국', '의료'],
    requiredDocuments: ['민원신청서'],
    relatedLaws: ['식품위생법', '의료법'],
  },
  '복지/사회': {
    department: '복지과',
    keywords: ['복지', '노인', '장애인', '아동', '청소년', '지원금'],
    requiredDocuments: ['민원신청서', '주민등록등본'],
    relatedLaws: ['사회복지사업법', '노인복지법'],
  },
  '세금/과태료': {
    department: '세무과',
    keywords: ['세금', '과태료', '지방세', '재산세', '취득세', '체납'],
    requiredDocuments: ['민원신청서', '납부영수증'],
    relatedLaws: ['지방세법', '지방세기본법'],
  },
  '기타': {
    department: '민원실',
    keywords: ['일반민원'],
    requiredDocuments: ['민원신청서'],
    relatedLaws: ['민원처리에 관한 법률'],
  },
};

export function searchByComplaintType(complaintType: string): SearchResult {
  const key =
    Object.keys(KNOWLEDGE_BASE).find(
      (k) => k === complaintType || complaintType.includes(k.split('/')[0] ?? k),
    ) ?? '기타';
  const info = KNOWLEDGE_BASE[key] ?? KNOWLEDGE_BASE['기타']!;
  return { complaintType: key, ...info };
}
