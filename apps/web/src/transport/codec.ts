/**
 * Codec — re-export serialization functions.
 * Import directly from the codec file to avoid pulling in server.ts (Node.js deps).
 */
export {
  serializeEnvelope,
  deserializeEnvelope,
  validateEnvelopeShape,
} from '../../../../packages/server-core/src/transport/codec.ts'
