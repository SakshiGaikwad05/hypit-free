export type MockOllamaRequest = {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
};

export type MockOllama = {
  readonly baseUrl: string;
  readonly state: { behavior: string; readonly requests: MockOllamaRequest[] };
  close(): Promise<void>;
};

export function startMockOllama(options?: {
  readonly port?: number;
  readonly models?: readonly string[];
  readonly behavior?: string;
}): Promise<MockOllama>;
