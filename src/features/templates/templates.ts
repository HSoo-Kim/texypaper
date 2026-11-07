export type PaperTemplate = {
  id: string;
  name: { ko: string; en: string };
  description: { ko: string; en: string };
  engine: 'pdflatex' | 'xelatex' | 'lualatex';
  rootTex: 'main.tex';
  files: { path: string; content: string }[];
};

const references = `@misc{sample2026,
  author = {Example, Alex},
  title = {A Sample Research Note},
  year = {2026},
  note = {Fictional entry for demonstrating citations; replace before publication}
}
`;

export const paperTemplates: PaperTemplate[] = [
  {
    id: 'article',
    name: { ko: '영문 논문', en: 'English article' },
    description: { ko: '초록, 네 개의 절, BibTeX 참고문헌 · pdfLaTeX', en: 'Abstract, four sections and BibTeX references · pdfLaTeX' },
    engine: 'pdflatex', rootTex: 'main.tex',
    files: [
      { path: 'main.tex', content: String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{graphicx}
\title{A New Research Paper}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle
\begin{abstract}
State the question, the approach, and the main finding in a few sentences.
\end{abstract}

\section{Introduction}
Explain the problem and why it matters. Replace the fictional example
citation with a source relevant to your work~\cite{sample2026}.

\section{Method}
Describe the materials, assumptions, and steps needed to repeat the study.

\section{Results}
Present the observations and distinguish them from their interpretation.
% Add an image to the project, then uncomment and update this example.
% \begin{figure}[htbp]
%   \centering
%   \includegraphics[width=0.7\linewidth]{figure.pdf}
%   \caption{Describe the figure.}
%   \label{fig:example}
% \end{figure}

\section{Conclusion}
Summarize what the findings support and identify the remaining limitations.

\bibliographystyle{plain}
\bibliography{references}
\end{document}
` },
      { path: 'references.bib', content: references },
    ],
  },
  {
    id: 'article-ko',
    name: { ko: '한글 논문', en: 'Korean article' },
    description: { ko: '한글 초록과 본문, ko.TeX 필요 · XeLaTeX', en: 'Korean abstract and sections; requires ko.TeX · XeLaTeX' },
    engine: 'xelatex', rootTex: 'main.tex',
    files: [{ path: 'main.tex', content: String.raw`% !TeX program = xelatex
\documentclass[11pt]{article}
\usepackage{kotex}
\title{새로운 연구 논문}
\author{작성자 이름}
\date{\today}

\begin{document}
\maketitle
\begin{abstract}
연구 질문, 연구 방법, 주요 결과를 간결하게 적습니다.
\end{abstract}

\section{서론}
연구할 문제를 소개하고 이 문제가 중요한 이유를 설명합니다.
기존 연구와 비교하여 이번 연구의 범위를 정합니다.

\section{연구 방법}
사용한 자료와 분석 절차를 적습니다.
다른 연구자가 같은 과정을 따라 할 수 있도록 조건을 설명합니다.

\section{연구 결과}
관찰한 결과를 제시합니다. 결과와 그에 대한 해석을 구분합니다.

\section{결론}
연구 질문에 대한 답을 정리하고 연구의 한계와 후속 과제를 적습니다.
\end{document}
` }],
  },
  {
    id: 'beamer',
    name: { ko: '발표 슬라이드', en: 'Presentation slides' },
    description: { ko: '제목 슬라이드와 두 장의 본문 · pdfLaTeX', en: 'Title slide and two content frames · pdfLaTeX' },
    engine: 'pdflatex', rootTex: 'main.tex',
    files: [{ path: 'main.tex', content: String.raw`\documentclass{beamer}
\usepackage[T1]{fontenc}
\title{A Research Presentation}
\author{Your Name}
\institute{Your Institution}
\date{\today}

\begin{document}
\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Question and Approach}
  \begin{itemize}
    \item State the question the audience should remember.
    \item Explain how the study addresses that question.
    \item Describe the evidence used in the analysis.
  \end{itemize}
\end{frame}

\begin{frame}{Findings and Discussion}
  \begin{block}{Main finding}
    Replace this sentence with the result supported by your evidence.
  \end{block}
  Explain the limitations and the next question to investigate.
\end{frame}
\end{document}
` }],
  },
  {
    id: 'report',
    name: { ko: '장별 보고서', en: 'Chapter-based report' },
    description: { ko: '분리된 장 파일과 BibTeX 참고문헌 · pdfLaTeX', en: 'Separate chapter files and BibTeX references · pdfLaTeX' },
    engine: 'pdflatex', rootTex: 'main.tex',
    files: [
      { path: 'main.tex', content: String.raw`\documentclass[11pt]{report}
\usepackage[T1]{fontenc}
\title{A New Research Report}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle
\tableofcontents
\input{chapters/introduction}
\input{chapters/conclusion}
\bibliographystyle{plain}
\bibliography{references}
\end{document}
` },
      { path: 'chapters/introduction.tex', content: String.raw`\chapter{Introduction}
Describe the problem, its context, and the objectives of the report.
Use relevant sources in place of this fictional example~\cite{sample2026}.

\section{Scope and Approach}
Define the questions addressed and explain the approach used to answer them.
` },
      { path: 'chapters/conclusion.tex', content: String.raw`\chapter{Conclusion}
Summarize the findings and explain how they address the report's objectives.

\section{Limitations and Next Steps}
Record the limits of the evidence and the work still needed.
` },
      { path: 'references.bib', content: references },
    ],
  },
];

/** Parent directories, ordered before their descendants and then by POSIX path. */
export function templateFolders(template: PaperTemplate): string[] {
  const folders = new Set<string>();
  for (const { path } of template.files) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join('/'));
  }
  return [...folders].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Existing names are project-relative paths; include folder entries to detect blockers. */
export function templateConflicts(template: PaperTemplate, existingNames: string[]): string[] {
  const existing = new Set(existingNames.map(path => path.toLowerCase()));
  return [...templateFolders(template), ...template.files.map(file => file.path)]
    .filter(path => existing.has(path.toLowerCase()));
}
