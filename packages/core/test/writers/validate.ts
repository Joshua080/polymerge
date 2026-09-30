/**
 * The Khronos glTF-Validator (npm `gltf-validator`, a dev dependency) as a test helper.
 */
import { createRequire } from 'node:module';

interface ValidatorMessage {
  code: string;
  message: string;
  severity: number;
  pointer?: string;
}

interface ValidatorReport {
  issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: ValidatorMessage[] };
}

const validator = createRequire(import.meta.url)('gltf-validator') as {
  validateBytes(data: Uint8Array, options?: Record<string, unknown>): Promise<ValidatorReport>;
  version(): string;
};

export interface IValidation {
  errors: number;
  warnings: number;
  infos: number;
  /** "CODE @pointer: message" for every error and warning. */
  problems: string[];
  /** The same for infos and hints (e.g. NODE_EMPTY for a transform-only node the source had too). */
  notes: string[];
}

/**
 * Validate GLB or .gltf bytes. `external` supplies the bytes of external resources (e.g. an image
 * the file references by URI); without it the validator reports them as unloadable.
 */
export async function validateGltf(bytes: Uint8Array, external?: (uri: string) => Uint8Array): Promise<IValidation> {
  const options: Record<string, unknown> = { writeTimestamp: false, maxIssues: 0 };
  if (external) options.externalResourceFunction = async (uri: string) => external(uri);
  const report = await validator.validateBytes(bytes, options);
  const i = report.issues;
  return {
    errors: i.numErrors,
    warnings: i.numWarnings,
    infos: i.numInfos,
    problems: i.messages.filter((m) => m.severity <= 1).map((m) => `${m.code} @${m.pointer ?? ''}: ${m.message}`),
    notes: i.messages.filter((m) => m.severity > 1).map((m) => `${m.code} @${m.pointer ?? ''}: ${m.message}`),
  };
}

export const validatorVersion = (): string => validator.version();
