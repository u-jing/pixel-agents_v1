import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

export interface ComplaintData {
  title: string;
  content: string;
}

export interface ExcelReadResult {
  complaints: ComplaintData[];
  usingSample: boolean;
  sampleReason?: string;
}

const TITLE_KEYS = ['title', '제목', '민원제목', '민원 제목', 'subject'];
const CONTENT_KEYS = ['content', '내용', '민원내용', '민원 내용', 'body', 'description'];
const MAX_COMPLAINTS = 3;

export const SAMPLE_COMPLAINTS: ComplaintData[] = [
  {
    title: '아파트 인근 공사장 야간 소음 민원',
    content:
      '저는 ○○아파트에 거주하고 있는 주민입니다. 인근 공사장에서 야간(22시 이후)에도 공사를 진행하여 소음으로 인한 수면 방해가 심각합니다. 관련 법규에 따른 조속한 단속과 제재를 요청드립니다.',
  },
  {
    title: '도로 포트홀 수리 긴급 요청',
    content:
      '○○로 123번지 앞 도로에 대형 포트홀(직경 약 30cm, 깊이 10cm)이 발생하여 차량 통행에 위험이 있습니다. 자전거 이용 시 넘어질 위험도 있어 신속한 보수를 요청드립니다.',
  },
  {
    title: '음식점 불법 간판 단속 요청',
    content:
      '○○동 456번지 소재 음식점에서 허가 면적을 초과하는 불법 간판을 설치하였습니다. 주민 통행에 불편을 주고 미관을 해치고 있으며, 옥외광고물법 위반으로 단속을 요청드립니다.',
  },
];

function findKey(rowKeys: string[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const found = rowKeys.find((k) => k.trim().toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  for (const candidate of candidates) {
    const found = rowKeys.find((k) => k.trim().toLowerCase().includes(candidate.toLowerCase()));
    if (found) return found;
  }
  return undefined;
}

export function readExcelComplaints(filePath: string): ExcelReadResult {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    return {
      complaints: SAMPLE_COMPLAINTS,
      usingSample: true,
      sampleReason: `엑셀 파일 없음 (샘플 사용): ${resolved}`,
    };
  }

  let workbook: ReturnType<typeof XLSX.readFile>;
  try {
    workbook = XLSX.readFile(resolved);
  } catch (err: unknown) {
    return {
      complaints: SAMPLE_COMPLAINTS,
      usingSample: true,
      sampleReason: `파일 읽기 실패 (샘플 사용): ${String(err)}`,
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { complaints: SAMPLE_COMPLAINTS, usingSample: true, sampleReason: '엑셀 시트 없음 (샘플 사용)' };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { complaints: SAMPLE_COMPLAINTS, usingSample: true, sampleReason: '시트 읽기 실패 (샘플 사용)' };
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  if (rows.length === 0) {
    return { complaints: SAMPLE_COMPLAINTS, usingSample: true, sampleReason: '데이터 없음 (샘플 사용)' };
  }

  const firstRow = rows[0]!;
  const allKeys = Object.keys(firstRow);
  const titleKey = findKey(allKeys, TITLE_KEYS);
  const contentKey = findKey(allKeys, CONTENT_KEYS);

  if (!contentKey) {
    return {
      complaints: SAMPLE_COMPLAINTS,
      usingSample: true,
      sampleReason: `내용 컬럼 없음 (샘플 사용). 현재 컬럼: ${allKeys.join(', ')}`,
    };
  }

  const complaints = rows.slice(0, MAX_COMPLAINTS).map((row, i) => {
    const content = String(row[contentKey] ?? '').trim();
    const rawTitle = titleKey ? String(row[titleKey] ?? '').trim() : '';
    const title = rawTitle || `민원 ${i + 1}: ${content.slice(0, 30)}...`;
    return { title, content };
  });

  return { complaints, usingSample: false };
}
