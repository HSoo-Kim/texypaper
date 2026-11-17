import type { Locale } from '../../ui/i18n';

// Matches the existing textarea and detached-chat prompt action bound.
export const MAX_WRITING_PROMPT_LENGTH = 65536;

export const WRITING_TASKS = [
  {
    id: 'shorten',
    label: { ko: '주장 유지하며 줄이기', en: 'Shorten without changing claims' },
    instructions: {
      ko: '제공한 논문 문장을 간결하게 줄여 주세요. 주장, 한정 조건, 불확실성, 숫자, 단위, 인용과 인용 키를 모두 유지하고 새 주장이나 근거를 추가하지 마세요. TeX 명령, 수식과 표기법을 보존하세요. 의미를 바꾸지 않고 줄이기 어려운 부분은 따로 알려 주세요.',
      en: 'Shorten the supplied paper text while preserving every claim, qualification, uncertainty, number, unit, citation and citation key. Do not add claims or evidence. Preserve TeX commands, equations and notation. Flag any passage that cannot be shortened without changing its meaning.',
    },
  },
  {
    id: 'english',
    label: { ko: '학술 영어 다듬기', en: 'Polish academic English' },
    instructions: {
      ko: '제공한 논문 문장을 자연스럽고 명확한 학술 영어로 다듬어 주세요. 의미, 주장 강도, 한정 조건, 숫자, 단위와 인용을 유지하세요. TeX 명령과 환경, 인용 키, 수식, 변수와 표기법은 변경하지 마세요. 사실을 추가하거나 결과를 과장하지 말고, 해석이 모호한 부분은 추측해 고치지 말고 질문으로 표시하세요.',
      en: 'Polish the supplied paper text into clear, natural academic English. Preserve meaning, strength of claims, qualifications, numbers, units and citations. Keep TeX commands and environments, citation keys, equations, variables and notation unchanged. Do not add facts or exaggerate results; flag ambiguous passages as questions rather than guessing.',
    },
  },
  {
    id: 'critique',
    label: { ko: '논증과 근거 점검', en: 'Critique argument and evidence' },
    instructions: {
      ko: '제공한 논문 내용의 논증과 근거를 점검해 주세요. 주장과 이를 뒷받침하는 제공된 근거를 연결하고, 논리적 비약, 상충하는 내용, 과장과 빠진 한정 조건을 구체적인 위치와 함께 지적하세요. 확인된 문제와 추가 검증이 필요한 의문을 구분하세요. 인용, 논문, 데이터나 결과를 만들어 내지 마세요. 필요한 근거는 추가로 확인할 사항으로 표시하고 이미 확보된 것처럼 쓰지 마세요.',
      en: 'Critique the argument and evidence in the supplied paper material. Map claims to the supplied support, and identify logical gaps, contradictions, overstatements and missing qualifications with specific locations. Distinguish demonstrated issues from questions needing verification. Do not fabricate citations, papers, data or results. Mark needed evidence as something to obtain or verify, not as evidence already available.',
    },
  },
  {
    id: 'reviewer-response',
    label: { ko: '심사 의견 답변 초안', en: 'Draft reviewer responses' },
    instructions: {
      ko: '제공한 심사 의견과 실제 수정 내역·실험 결과만으로 항목별 답변 초안을 작성해 주세요. 각 의견을 해당 답변과 연결하고, 완료된 수정과 앞으로의 제안을 구분하세요. 근거 없는 주장과 빠진 정보는 [근거 필요] 또는 [정보 필요]로 표시하세요. 수행하지 않은 실험, 얻지 않은 결과, 적용하지 않은 수정, 인용이나 쪽·줄 번호를 만들어 내지 마세요. 심사 의견이나 결과가 없으면 답변을 지어내지 말고 필요한 자료를 요청하세요.',
      en: 'Draft a point-by-point response using only the supplied reviewer comments and actual revisions or experimental results. Link each comment to its response and distinguish completed changes from proposed work. Flag unsupported assertions and missing information as [support needed] or [information needed]. Do not invent experiments, results, applied revisions, citations or page/line numbers. If comments or results are missing, request the needed material instead of inventing a response.',
    },
  },
] as const;

export type WritingTask = typeof WRITING_TASKS[number];

export function appendWritingTask(prompt: string, task: WritingTask, locale: Locale): string | null {
  const instructions = `${task.instructions[locale]}\n\n${locale === 'ko' ? '소스 수정은 검토할 제안으로만 제시하고 직접 적용하지 마세요.' : 'Present source edits only as proposals for review; do not apply them directly.'}`;
  const separator = prompt.length ? '\n\n' : '';
  if (prompt.length + separator.length + instructions.length > MAX_WRITING_PROMPT_LENGTH) return null;
  return `${prompt}${separator}${instructions}`;
}
