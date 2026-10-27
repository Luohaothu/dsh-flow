import { z } from 'zod'

let JsonValueRemoteCodec$schema$value
const JsonValueRemoteCodec$schema = () => (JsonValueRemoteCodec$schema$value ??= z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]))
let JsonValueRemoteCodec$schema2$value
const JsonValueRemoteCodec$schema2 = () => (JsonValueRemoteCodec$schema2$value ??= z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema2())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema2()))]))
let dsh_flow_flowDashboard_connection_result$schema$value
const dsh_flow_flowDashboard_connection_result$schema = () => (dsh_flow_flowDashboard_connection_result$schema$value ??= z.object({
  'address': z.string().readonly(),
  'epoch': z.string().readonly(),
  'version': z.object({
  'major': z.number(),
  'minor': z.number(),
}).readonly(),
  'configuration': z.object({
  'entryId': z.string().readonly().optional(),
  'effective': z.object({
  'stateDirectory': z.string(),
  'defaults': z.object({
  'model': z.object({
  'provider': z.string(),
  'id': z.string(),
}).optional(),
  'params': z.object({
  'version': z.literal(1),
  'reasoningEffort': z.string().optional(),
  'temperature': z.number().optional(),
  'maxTokens': z.number().optional(),
}).optional(),
  'permission': z.union([z.literal("read-only"), z.literal("workspace-write"), z.literal("full-access")]).optional(),
  'hostExtras': z.object({
  'dsh': z.object({
  'stop': z.array(z.string()).optional(),
}).optional(),
}).optional(),
  'preset': z.string().optional(),
  'skills': z.array(z.string()).optional(),
}),
  'cwd': z.string().optional(),
  'rootRole': z.string().optional(),
  'patternSources': z.array(z.string()),
  'maxConcurrentAgents': z.number(),
  'cleanup': z.object({
  'gracefulTimeoutMs': z.number(),
  'immediateTimeoutMs': z.number(),
}),
  'connection': z.object({
  'port': z.number().optional(),
  'staticDirectory': z.string().optional(),
  'allowedOrigins': z.array(z.string()).optional(),
  'prices': z.array(z.object({
  'model': z.object({
  'provider': z.string(),
  'id': z.string(),
}),
  'currency': z.string(),
  'input': z.number(),
  'output': z.number(),
  'cacheRead': z.number().optional(),
  'cacheWrite': z.number().optional(),
})).optional(),
}),
}).readonly(),
  'requested': z.object({
  'stateDirectory': z.string(),
  'defaults': z.object({
  'model': z.object({
  'provider': z.string(),
  'id': z.string(),
}).optional(),
  'params': z.object({
  'version': z.literal(1),
  'reasoningEffort': z.string().optional(),
  'temperature': z.number().optional(),
  'maxTokens': z.number().optional(),
}).optional(),
  'permission': z.union([z.literal("read-only"), z.literal("workspace-write"), z.literal("full-access")]).optional(),
  'hostExtras': z.object({
  'dsh': z.object({
  'stop': z.array(z.string()).optional(),
}).optional(),
}).optional(),
  'preset': z.string().optional(),
  'skills': z.array(z.string()).optional(),
}),
  'cwd': z.string().optional(),
  'rootRole': z.string().optional(),
  'patternSources': z.array(z.string()),
  'maxConcurrentAgents': z.number(),
  'cleanup': z.object({
  'gracefulTimeoutMs': z.number(),
  'immediateTimeoutMs': z.number(),
}),
  'connection': z.object({
  'port': z.number().optional(),
  'staticDirectory': z.string().optional(),
  'allowedOrigins': z.array(z.string()).optional(),
  'prices': z.array(z.object({
  'model': z.object({
  'provider': z.string(),
  'id': z.string(),
}),
  'currency': z.string(),
  'input': z.number(),
  'output': z.number(),
  'cacheRead': z.number().optional(),
  'cacheWrite': z.number().optional(),
})).optional(),
}),
}).readonly(),
  'restartRequired': z.array(z.string()).readonly(),
  'catalog': z.object({
  'patterns': z.array(z.object({
  'id': z.string().readonly(),
  'description': z.string().readonly(),
})).readonly(),
  'diagnostics': z.array(z.object({
  'path': z.string().readonly(),
  'message': z.string().readonly(),
})).readonly(),
}).readonly(),
  'application': z.object({
  'revision': z.number().readonly(),
  'status': z.union([z.literal("applied"), z.literal("failed")]).readonly(),
  'error': z.object({
  'message': z.string().readonly(),
}).readonly().optional(),
}).readonly(),
}).readonly(),
}))
let dsh_flow_flowDashboard_followNativeSession_parameter_0$schema$value
const dsh_flow_flowDashboard_followNativeSession_parameter_0$schema = () => (dsh_flow_flowDashboard_followNativeSession_parameter_0$schema$value ??= z.object({
  'target': z.object({
  'runId': z.string().readonly(),
  'instanceId': z.string().readonly(),
  'sessionId': z.intersection(z.string(), z.unknown()).readonly(),
}).readonly(),
  'request': z.object({
  'maxMessages': z.number().readonly().optional(),
  'turnWindow': z.object({
  'minMessages': z.number().readonly(),
  'minTurns': z.number().readonly(),
}).readonly().optional(),
  'assistantStream': z.literal(true).readonly().optional(),
}).readonly(),
}))
let dsh_flow_flowDashboard_followNativeSession_result$schema$value
const dsh_flow_flowDashboard_followNativeSession_result$schema = () => (dsh_flow_flowDashboard_followNativeSession_result$schema$value ??= z.union([z.object({
  'epoch': z.string().readonly(),
  'kind': z.literal("journal").readonly(),
  'frame': z.union([z.object({
  'type': z.literal("snapshot").readonly(),
  'header': z.object({
  'version': z.number().readonly(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'createdAt': z.number().readonly(),
  'cwd': z.string().readonly().optional(),
  'parentSession': z.intersection(z.string(), z.unknown()).readonly().optional(),
  'isSeeded': z.boolean().readonly(),
  'origin': z.literal("subagent").readonly().optional(),
  'delegationDepth': z.number().readonly().optional(),
  'agentPreset': z.string().readonly().optional(),
}).readonly(),
  'cursor': z.number().readonly(),
  'records': z.array(z.object({
  'type': z.literal("event").readonly(),
  'event': z.object({
  'type': z.string().readonly(),
  'seq': z.number().readonly(),
  'time': z.number().readonly(),
  'data': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly(),
  'ignorable': z.literal(true).readonly().optional(),
  'sourceEventSeqs': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly().optional(),
  'surfaceOp': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly().optional(),
}).readonly(),
})).readonly(),
  'hasMore': z.boolean().readonly(),
  'projections': z.object({
  'asOfSeq': z.number().readonly(),
  'values': z.intersection(z.object({
  'inbox': z.object({
  'next-turn': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
  'next-step': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
}).optional(),
  'title': z.union([z.literal(null), z.string()]).optional(),
  'sessionListMetadata': z.object({
  'blank': z.boolean().readonly(),
  'lastPromptAt': z.union([z.literal(null), z.number()]).readonly(),
}).optional(),
  'imageLimits': z.object({
  'maxImageBytes': z.number(),
  'maxImagesPerMessage': z.number(),
  'maxMessageImageBytes': z.number(),
  'maxImagePixels': z.number(),
  'maxImageDimension': z.number(),
  'mediaTypes': z.array(z.union([z.literal("image/png"), z.literal("image/jpeg"), z.literal("image/webp"), z.literal("image/gif")])),
}).optional(),
  'modelSelection': z.object({
  'lastUsed': z.union([z.literal(null), z.object({
  'provider': z.string().readonly(),
  'model': z.string().readonly(),
  'reasoningEffort': z.string().readonly().optional(),
})]).readonly(),
  'next': z.union([z.literal(null), z.object({
  'provider': z.string().readonly(),
  'model': z.string().readonly(),
  'reasoningEffort': z.string().readonly().optional(),
})]).readonly(),
}).optional(),
  'agentPreset': z.union([z.literal(null), z.string()]).optional(),
}), z.record(z.string(), z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly()).readonly(),
}).readonly(),
  'assistantStream': z.object({
  'revision': z.number().readonly(),
  'activeAttempt': z.object({
  'attemptId': z.intersection(z.string(), z.unknown()).readonly(),
  'startedAfterSeq': z.union([z.intersection(z.number(), z.unknown()), z.literal(-1)]).readonly(),
  'turn': z.number().readonly(),
  'step': z.number().readonly(),
  'nextIndex': z.number().readonly(),
  'stream': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
}).readonly().optional(),
}).readonly().optional(),
}), z.object({
  'type': z.literal("event").readonly(),
  'event': z.object({
  'type': z.string().readonly(),
  'seq': z.number().readonly(),
  'time': z.number().readonly(),
  'data': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly(),
  'ignorable': z.literal(true).readonly().optional(),
  'sourceEventSeqs': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly().optional(),
  'surfaceOp': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly().optional(),
}).readonly(),
}), z.object({
  'type': z.literal("assistant-stream").readonly(),
  'frame': z.union([z.object({
  'type': z.literal("start").readonly(),
  'attemptId': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
  'startedAfterSeq': z.union([z.intersection(z.number(), z.unknown()), z.literal(-1)]).readonly(),
  'turn': z.number().readonly(),
  'step': z.number().readonly(),
}), z.object({
  'type': z.literal("chunk").readonly(),
  'attemptId': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
  'index': z.number().readonly(),
  'time': z.number().readonly(),
  'chunk': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))]).readonly(),
}), z.object({
  'type': z.literal("end").readonly(),
  'attemptId': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
  'index': z.number().readonly(),
  'outcome': z.union([z.object({
  'kind': z.literal("committed").readonly(),
  'eventType': z.union([z.literal("assistant/message"), z.literal("assistant/attempt")]).readonly(),
  'seq': z.number().readonly(),
}), z.object({
  'kind': z.literal("abandoned").readonly(),
})]).readonly(),
})]).readonly(),
})]).readonly(),
}), z.object({
  'epoch': z.string().readonly(),
  'kind': z.literal("state").readonly(),
  'summary': z.object({
  'agentAvailable': z.boolean().readonly(),
  'sessionId': z.intersection(z.string(), z.unknown()).readonly(),
  'updatedAt': z.number().readonly(),
  'running': z.boolean().readonly(),
  'blank': z.boolean().readonly(),
  'parentSessionId': z.intersection(z.string(), z.unknown()).readonly().optional(),
  'origin': z.literal("subagent").readonly().optional(),
  'cwd': z.string().readonly().optional(),
  'projections': z.object({
  'kind': z.union([z.literal("cached"), z.literal("sequenced")]).readonly(),
  'asOfSeq': z.number().readonly(),
  'values': z.intersection(z.object({
  'inbox': z.object({
  'next-turn': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
  'next-step': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
}).optional(),
  'title': z.union([z.literal(null), z.string()]).optional(),
  'sessionListMetadata': z.object({
  'blank': z.boolean().readonly(),
  'lastPromptAt': z.union([z.literal(null), z.number()]).readonly(),
}).optional(),
  'imageLimits': z.object({
  'maxImageBytes': z.number(),
  'maxImagesPerMessage': z.number(),
  'maxMessageImageBytes': z.number(),
  'maxImagePixels': z.number(),
  'maxImageDimension': z.number(),
  'mediaTypes': z.array(z.union([z.literal("image/png"), z.literal("image/jpeg"), z.literal("image/webp"), z.literal("image/gif")])),
}).optional(),
  'modelSelection': z.object({
  'lastUsed': z.union([z.literal(null), z.object({
  'provider': z.string().readonly(),
  'model': z.string().readonly(),
  'reasoningEffort': z.string().readonly().optional(),
})]).readonly(),
  'next': z.union([z.literal(null), z.object({
  'provider': z.string().readonly(),
  'model': z.string().readonly(),
  'reasoningEffort': z.string().readonly().optional(),
})]).readonly(),
}).optional(),
  'agentPreset': z.union([z.literal(null), z.string()]).optional(),
}), z.record(z.string(), z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly()).readonly(),
}).readonly().optional(),
}).readonly(),
  'projections': z.object({
  'asOfSeq': z.number().readonly(),
  'values': z.intersection(z.object({
  'inbox': z.object({
  'next-turn': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
  'next-step': z.array(z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly(),
}).optional(),
  'title': z.union([z.literal(null), z.string()]).optional(),
  'sessionListMetadata': z.object({
  'blank': z.boolean().readonly(),
  'lastPromptAt': z.union([z.literal(null), z.number()]).readonly(),
}).optional(),
  'imageLimits': z.object({
  'maxImageBytes': z.number(),
  'maxImagesPerMessage': z.number(),
  'maxMessageImageBytes': z.number(),
  'maxImagePixels': z.number(),
  'maxImageDimension': z.number(),
  'mediaTypes': z.array(z.union([z.literal("image/png"), z.literal("image/jpeg"), z.literal("image/webp"), z.literal("image/gif")])),
}).optional(),
  'modelSelection': z.object({
  'lastUsed': z.union([z.literal(null), z.object({
  'provider': z.string().readonly(),
  'model': z.string().readonly(),
  'reasoningEffort': z.string().readonly().optional(),
})]).readonly(),
  'next': z.union([z.literal(null), z.object({
  'provider': z.string().readonly(),
  'model': z.string().readonly(),
  'reasoningEffort': z.string().readonly().optional(),
})]).readonly(),
}).optional(),
  'agentPreset': z.union([z.literal(null), z.string()]).optional(),
}), z.record(z.string(), z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema()))])).readonly()).readonly(),
}).readonly(),
})]))
let dsh_flow_flowDashboard_pageNativeSession_parameter_0$schema$value
const dsh_flow_flowDashboard_pageNativeSession_parameter_0$schema = () => (dsh_flow_flowDashboard_pageNativeSession_parameter_0$schema$value ??= z.object({
  'target': z.object({
  'runId': z.string().readonly(),
  'instanceId': z.string().readonly(),
  'sessionId': z.intersection(z.string(), z.unknown()).readonly(),
}).readonly(),
  'epoch': z.string().readonly(),
  'request': z.object({
  'maxMessages': z.number().readonly().optional(),
  'turnWindow': z.object({
  'minMessages': z.number().readonly(),
  'minTurns': z.number().readonly(),
}).readonly().optional(),
  'throughSeq': z.number().readonly(),
  'beforeSeq': z.number().readonly().optional(),
}).readonly(),
}))
let dsh_flow_flowDashboard_pageNativeSession_result$schema$value
const dsh_flow_flowDashboard_pageNativeSession_result$schema = () => (dsh_flow_flowDashboard_pageNativeSession_result$schema$value ??= z.object({
  'records': z.array(z.object({
  'type': z.literal("event").readonly(),
  'event': z.object({
  'type': z.string().readonly(),
  'seq': z.number().readonly(),
  'time': z.number().readonly(),
  'data': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema2())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema2()))]).readonly(),
  'ignorable': z.literal(true).readonly().optional(),
  'sourceEventSeqs': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema2())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema2()))]).readonly().optional(),
  'surfaceOp': z.union([z.literal(null), z.string(), z.number(), z.literal(false), z.literal(true), z.array(z.lazy(() => JsonValueRemoteCodec$schema2())), z.record(z.string(), z.lazy(() => JsonValueRemoteCodec$schema2()))]).readonly().optional(),
}).readonly(),
})).readonly(),
  'hasMore': z.boolean().readonly(),
}))
let dsh_flow_flowDashboard_readNativeAttachment_parameter_0$schema$value
const dsh_flow_flowDashboard_readNativeAttachment_parameter_0$schema = () => (dsh_flow_flowDashboard_readNativeAttachment_parameter_0$schema$value ??= z.object({
  'target': z.object({
  'runId': z.string().readonly(),
  'instanceId': z.string().readonly(),
  'sessionId': z.intersection(z.string(), z.unknown()).readonly(),
}).readonly(),
  'epoch': z.string().readonly(),
  'attachmentId': z.intersection(z.string(), z.unknown()).readonly(),
}))
let dsh_flow_flowDashboard_readNativeAttachment_result$schema$value
const dsh_flow_flowDashboard_readNativeAttachment_result$schema = () => (dsh_flow_flowDashboard_readNativeAttachment_result$schema$value ??= z.object({
  'attachment': z.object({
  'attachmentId': z.intersection(z.string(), z.unknown()),
  'mediaType': z.union([z.literal("image/png"), z.literal("image/jpeg"), z.literal("image/webp"), z.literal("image/gif")]),
  'bytes': z.number(),
  'width': z.number(),
  'height': z.number(),
  'name': z.string().optional(),
  'originalDimensions': z.object({
  'width': z.number(),
  'height': z.number(),
}).optional(),
}).readonly(),
  'data': z.string().readonly(),
}))

export const TYPERT_REMOTE = {
  package: 'dsh-flow',
  descriptors: [
    {
      id: 'dsh-flow#flowDashboard/connection',
      service: 'flowDashboard',
      namespace: 'flowDashboard',
      method: 'connection',
      invocation: { kind: 'direct' },
      parameters: [
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-flow/native/protocol#FlowConnection',
        create: dsh_flow_flowDashboard_connection_result$schema,
      },
      sourceLocation: {"file":"packages/dsh-flow/src/native/host.ts","line":37,"column":3},
    },
    {
      id: 'dsh-flow#flowDashboard/followNativeSession',
      service: 'flowDashboard',
      namespace: 'flowDashboard',
      method: 'followNativeSession',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          wire: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-flow/native/protocol#FlowNativeFollowInput',
            create: dsh_flow_flowDashboard_followNativeSession_parameter_0$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-flow/native/protocol#FlowNativeFrame',
        create: dsh_flow_flowDashboard_followNativeSession_result$schema,
      },
      sourceLocation: {"file":"packages/dsh-flow/src/native/host.ts","line":40,"column":3},
    },
    {
      id: 'dsh-flow#flowDashboard/pageNativeSession',
      service: 'flowDashboard',
      namespace: 'flowDashboard',
      method: 'pageNativeSession',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          wire: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-flow/native/protocol#FlowNativePageInput',
            create: dsh_flow_flowDashboard_pageNativeSession_parameter_0$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-flow/native/protocol#FlowNativePageValue',
        create: dsh_flow_flowDashboard_pageNativeSession_result$schema,
      },
      sourceLocation: {"file":"packages/dsh-flow/src/native/host.ts","line":43,"column":3},
    },
    {
      id: 'dsh-flow#flowDashboard/readNativeAttachment',
      service: 'flowDashboard',
      namespace: 'flowDashboard',
      method: 'readNativeAttachment',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          wire: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-flow/native/protocol#FlowNativeAttachmentInput',
            create: dsh_flow_flowDashboard_readNativeAttachment_parameter_0$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-flow/native/protocol#FlowNativeAttachmentValue',
        create: dsh_flow_flowDashboard_readNativeAttachment_result$schema,
      },
      sourceLocation: {"file":"packages/dsh-flow/src/native/host.ts","line":46,"column":3},
    },
  ],
}

export default TYPERT_REMOTE
