export interface ProbeIdea {
  id?: string;
  selected?: boolean;
  probe_type: string;
  probe_name: string;
  explanation: string;
  reference: string;
  confidence: string;
}

export interface DevDoc {
  doc_id: string;
  selected?: boolean;
  title: string;
  confidence: string;
  metric: any;
  expectation: string;
  computation: any;
  outputs: any;
  strengths: string[];
  weaknesses: string[];
}

export type CodexParsed =
  | { kind: 'RAW'; raw: string }
  | { kind: 'PROBE_IDEA'; probes: ProbeIdea[]; raw: string }
  | { kind: 'DEV_DOC'; docs: DevDoc[]; raw: string };

export function parseCodexResult(raw: string): CodexParsed {
  const rawText = raw ?? '';
  const trimmed = rawText.trim();

  if (!trimmed) {
    return { kind: 'RAW', raw: rawText };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'RAW', raw: rawText };
    }

    if (
      Array.isArray((parsed as any).PROBE_IDEA) &&
      (parsed as any).PROBE_IDEA.length === 10
    ) {
      return {
        kind: 'PROBE_IDEA',
        probes: (parsed as any).PROBE_IDEA as ProbeIdea[],
        raw: rawText,
      };
    }

    if (
      Array.isArray((parsed as any).DEV_DOC) &&
      (parsed as any).DEV_DOC.length === 3
    ) {
      return {
        kind: 'DEV_DOC',
        docs: (parsed as any).DEV_DOC as DevDoc[],
        raw: rawText,
      };
    }
  } catch (error) {
    // swallow JSON errors and fall back to RAW
  }

  return { kind: 'RAW', raw: rawText };
}
