import { Type, type Static } from 'typebox';

const closed = { additionalProperties: false };
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const uri = Type.String({ minLength: 1, maxLength: 2048 });
const date = Type.String({ minLength: 1, maxLength: 64 });
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const coordinate = Type.Integer({ minimum: 0, maximum: 100000 });
const page = Type.Integer({ minimum: 1, maximum: 100 });
const range = { start: coordinate, end: coordinate };
const pageRecord = Type.Object(
  { page, state: Type.Literal('text'), directImagePresent: Type.Boolean(), ...range },
  closed,
);

/** Closed representation of the existing offline selector; replay supplies its deeper invariants. */
export const selectedPacketSchema = Type.Object(
  {
    kind: Type.Literal('offline-page-window-selection'),
    algorithm: Type.Literal('literal-all-hits-adjacent-page-v1'),
    sourceUriLabel: Type.Union([uri, Type.Null()]),
    inputSha256: sha,
    sourceDigest: sha,
    fullTextDigest: sha,
    fullTextUnits: coordinate,
    projection: Type.Object(
      {
        parser: Type.Literal('pypdf6.20.1'),
        coordinateUnits: Type.Literal('UTF16'),
        pageSeparator: Type.Literal('\n\n'),
      },
      closed,
    ),
    coordinate: Type.String({ minLength: 1, maxLength: 200 }),
    request: Type.Object(
      {
        claim: Type.String({ minLength: 1, maxLength: 1600 }),
        // Schema lengths count code points; selector replay enforces 2–128 UTF16 units.
        anchors: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 8,
        }),
        contextPages: Type.Array(page, { maxItems: 100 }),
        adjacentPages: Type.Literal(1),
      },
      closed,
    ),
    occurrences: Type.Array(
      Type.Object(
        {
          anchorIndex: Type.Integer({ minimum: 0, maximum: 7 }),
          ...range,
          pages: Type.Array(page, { minItems: 1, maxItems: 100 }),
        },
        closed,
      ),
      { minItems: 1, maxItems: 128 },
    ),
    windows: Type.Array(
      Type.Object(
        {
          ...range,
          pages: Type.Array(page, { minItems: 1, maxItems: 100 }),
          text: Type.String({ minLength: 1, maxLength: 48000 }),
        },
        closed,
      ),
      { minItems: 1, maxItems: 100 },
    ),
    selectedPages: Type.Array(pageRecord, { minItems: 1, maxItems: 100 }),
    unreadPages: Type.Array(page, { maxItems: 100 }),
    unreadRanges: Type.Array(Type.Object(range, closed), { maxItems: 101 }),
    selectedUnits: Type.Integer({ minimum: 1, maximum: 48000 }),
    completeSourceCoverage: Type.Literal(false),
    confidence: Type.Literal('Unknown'),
    semanticReview: Type.Literal('not-performed'),
    limits: Type.Object(
      {
        maxOccurrences: Type.Literal(128),
        emittedUTF16: Type.Literal(48000),
        emittedUTF8Bytes: Type.Literal(300000),
      },
      closed,
    ),
    omissions: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), {
      minItems: 1,
      maxItems: 14, // Ten extraction warnings plus four fixed selector warnings.
    }),
  },
  closed,
);

/** Operator-registered acquisition metadata, not request text, a parent or a signature. */
export const selectedCaptureSchema = Type.Object(
  {
    kind: Type.Literal('retained-public-pdf-capture-v1'),
    requestedUri: uri,
    finalUri: uri,
    fetchedAt: date,
    status: Type.Literal(200),
    bytes: Type.Integer({ minimum: 1, maximum: 20971520 }),
    documentDigest: sha,
    acquisitionReceiptDigest: sha,
    parser: Type.Literal('pypdf6.20.1'),
    extractionWorkerDigest: sha,
    publishedAt: Type.Optional(date),
    followedFrom: Type.Optional(
      Type.Object(
        {
          kind: Type.Literal('contextual-outlink-not-claim-parent'),
          uri,
          documentDigest: sha,
          snapshotDigest: sha,
          observedCaptureDigest: sha,
          observedAt: date,
          relatedAnswerRunId: Type.Optional(uuid),
          relatedCheckRunId: Type.Optional(uuid),
          relatedClaimReceiptDigest: Type.Optional(sha),
        },
        closed,
      ),
    ),
  },
  closed,
);

export const selectedClaimMaterialSchema = Type.Object(
  {
    sourceIndex: Type.Literal(0),
    requestedUri: uri,
    state: Type.Literal('usable'),
    finalUri: uri,
    text: Type.String({ minLength: 1, maxLength: 48000 }),
    snapshotDigest: sha,
    documentDigest: sha,
    normalizer: Type.Literal('pdf-page-windows-v1'),
    fetchedAt: date,
    publishedAt: Type.Optional(date),
    scope: Type.Literal('selected-page-windows'),
    omissions: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), {
      minItems: 1,
      maxItems: 15, // Complete packet warnings plus the fixed host coverage warning.
    }),
    packet: selectedPacketSchema,
    capture: selectedCaptureSchema,
    archive: Type.Object(
      { extractionBase64: Type.String({ maxLength: 333336 }), extractionDigest: sha },
      closed,
    ),
    lineageDigest: sha,
  },
  closed,
);

export const selectedFindingSpanSchema = Type.Object(
  {
    findingIndex: Type.Integer({ minimum: 0, maximum: 3 }),
    sourceIndex: Type.Literal(0),
    occurrences: Type.Array(
      Type.Object(
        {
          windowIndex: Type.Integer({ minimum: 0, maximum: 99 }),
          ...range,
          startPage: page,
          endPage: page,
        },
        closed,
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  closed,
);

export type SelectedPacket = Static<typeof selectedPacketSchema>;
export type SelectedCapture = Static<typeof selectedCaptureSchema>;
export type SelectedClaimMaterial = Static<typeof selectedClaimMaterialSchema>;
export type SelectedFindingSpan = Static<typeof selectedFindingSpanSchema>;
