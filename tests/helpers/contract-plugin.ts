import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import DefaultModel from '@deepseek-ai/dsh-agent-default-model';
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local';
import FileUploads from '@deepseek-ai/dsh-client-file-upload';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import SessionController from '@deepseek-ai/dsh-api-session-controller';
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import Typert from '@deepseek-ai/dsh-typert-registry';
import Workspace from '@deepseek-ai/dsh-workspace';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';

export async function enablePluginHost(host: Context, directory: string): Promise<void> {
  if (!host.get('agentDefaultModel')) await host.plugin(DefaultModel, { provider: 'fixture', model: 'model', reasoningEffort: 'medium' });
  if (!host.get('attachments')) await host.plugin(AttachmentLocal, { dshHome: join(directory, 'attachment-home') });
  if (!host.get('typert')) await host.plugin(Typert);
  if (!host.get('credentials')) await host.plugin(Credentials, { path: join(directory, 'credentials.yaml'), dshHome: directory, watch: false });
  if (!host.get('connection')) await host.plugin(Connection);
  if (!host.get('fileUploads')) await host.plugin(FileUploads);
  if (!host.get('storage')) await host.plugin(Storage);
  if (!host.get('storageDomain')) {
    await host.plugin(StorageJson, { root: join(directory, 'storage') });
    await host.plugin(StorageDomain, { backend: 'json' });
  }
  if (!host.get('workspaceRegistry')) await host.plugin(Workspace);
  if (!host.get('sessionQuery')) await host.plugin(SessionQuery, { path: join(directory, 'query.sqlite'), openAt: 'never' });
  if (!host.get('sessionController')) await host.plugin(SessionController, { nativeOpen: false });
  for (const service of ['sessionController', 'fileUploads', 'workspaceRegistry', 'sessionQuery', 'connection']) {
    if (!host.get(service)) throw new Error(`Actual plugin fixture service did not activate: ${service}`);
  }
}
