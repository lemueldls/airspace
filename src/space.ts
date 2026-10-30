import type { Client } from '@atproto/lex-client'
import type { DidString, RecordSchema } from '@atproto/lex-schema'
import type { Backend, RawRecord, SpaceUri, WriteRef } from './backend.ts'
import type { Space } from './model.ts'
import { XrpcResponseError } from '@atproto/lex-client'
import { LexValidationError } from '@atproto/lex-schema'
import { isNotFound, PAGE, paginate, readOnly, scoped, spaceUri } from './backend.ts'
import { cidFromBlob } from './blob.ts'
import { SpacesUnsupportedError, ValidationError } from './errors.ts'
import { com } from './lex/index.ts'

/** A client that reports a failing space call as `SpacesUnsupportedError` when the PDS has no spaces. */
export function guardSpaces(client: Client, service: string, supported: () => Promise<boolean>): Client {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'call' || typeof value !== 'function')
        return value
      return async (...args: Parameters<Client['call']>) => {
        try {
          return await (value as Client['call']).apply(target, args)
        }
        catch (err) {
          // A refused credential says nothing about space support; `AuthMissing` on an authenticated call means no route.
          const auth = err instanceof XrpcResponseError && (err.status === 403 || (err.status === 401 && err.error !== 'AuthMissing'))
          if (err instanceof XrpcResponseError && !auth && !await supported())
            throw new SpacesUnsupportedError(service, { cause: err })
          throw err
        }
      }
    },
  })
}

export interface SpaceBackendOptions {
  space: SpaceUri
  repo: DidString
  service: string
  client?: Client
}

// The PDS cannot validate third-party lexicons in spaces (atproto#5433).
export function createSpaceBackend({ space, repo, service, client }: SpaceBackendOptions): Backend {
  const require = (): Client => {
    if (!client)
      throw readOnly('use spaces')
    return client
  }
  const parse = (schema: RecordSchema, raw: RawRecord): RawRecord => {
    try {
      return { uri: raw.uri, cid: raw.cid, value: schema.parse(raw.value) }
    }
    catch (err) {
      if (err instanceof LexValidationError)
        throw new ValidationError(`${schema.$type}/${raw.uri.slice(raw.uri.lastIndexOf('/') + 1)}`, err)
      throw err
    }
  }

  const page: Backend['page'] = async (schema, { limit, cursor, reverse, unvalidated } = {}) => {
    const res = await scoped(() => require().call(com.atproto.space.listRecords, { space, repo, collection: schema.$type, limit: limit ?? PAGE, cursor, reverse }))
    return {
      records: res.records.filter(r => r.value).map((r) => {
        const raw = { uri: `${space}/${repo}/${r.collection}/${r.rkey}`, cid: r.cid, value: r.value }
        return unvalidated ? raw : parse(schema, raw)
      }),
      cursor: res.cursor,
    }
  }

  return {
    repo,
    location: `${space}/${repo}`,
    blobUrl: (blob) => {
      const cid = cidFromBlob(blob)
      if (!cid)
        return null
      return `${service.replace(/\/$/, '')}/xrpc/com.atproto.space.getBlob?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(repo)}&cid=${encodeURIComponent(cid)}`
    },
    async get(schema, rkey) {
      try {
        const res = await scoped(() => require().call(com.atproto.space.getRecord, { space, repo, collection: schema.$type, rkey }))
        return parse(schema, res as RawRecord)
      }
      catch (err) {
        if (isNotFound(err))
          return null
        throw err
      }
    },
    page,
    list: (schema, { limit, unvalidated } = {}) => paginate(page, schema, limit, unvalidated),
    async create(schema, record, rkey): Promise<WriteRef> {
      return await scoped(() => require().call(com.atproto.space.createRecord, { space, repo, collection: schema.$type, rkey, record }))
    },
    async put(schema, rkey, record): Promise<WriteRef> {
      return await scoped(() => require().call(com.atproto.space.putRecord, { space, repo, collection: schema.$type, rkey, record }))
    },
    async delete(schema, rkey) {
      await scoped(() => require().call(com.atproto.space.deleteRecord, { space, repo, collection: schema.$type, rkey }))
    },
    async batch(writes) {
      const res = await scoped(() => require().call(com.atproto.space.applyWrites, {
        space,
        repo,
        writes: writes.map(({ operation, schema, rkey, value }) => {
          const op = { collection: schema.$type, rkey, value } as any
          return operation === 'create' ? com.atproto.space.applyWrites.create.build(op) : operation === 'put' ? com.atproto.space.applyWrites.update.build(op) : com.atproto.space.applyWrites.delete.build(op)
        }),
      }))
      return (res.results ?? []).map(result => 'uri' in result ? { uri: result.uri, cid: result.cid } : undefined)
    },
  }
}

export type SpacePolicy = 'public' | 'member-list' | { managingApp: string }
export type SpaceAppAccess = 'open' | { allowed: readonly string[] }

export type SpacePolicyDetail
  = | { type: 'personalspace' }
    | {
      type: 'memberspace'
      publicRead?: boolean
      publicWrite?: boolean
      allowedApps?: readonly string[]
      publishPolicy?: boolean
      publishMembers?: boolean
    }
    | { type: 'managedspace', managingApp: string, publishPolicy?: boolean }

export interface SpaceInfo {
  uri: string
  read: SpacePolicy
  write: SpacePolicy
  appAccess: SpaceAppAccess
  policy: SpacePolicyDetail
}

export interface EnsureSpaceOptions {
  read?: SpacePolicy
  write?: SpacePolicy
  appAccess?: SpaceAppAccess
  policy?: SpacePolicyDetail
  publishPolicy?: boolean
  publishMembers?: boolean
}

/** A member of a space, and which halves of the member-list policy they satisfy. */
export interface SpaceMember {
  did: DidString
  read: boolean
  write: boolean
}

export type SpaceMemberAccess = Partial<Omit<SpaceMember, 'did'>>

function policyToLex(policy: SpacePolicyDetail) {
  if (policy.type === 'personalspace')
    return com.atproto.personalspace.policy.$build({})
  if (policy.type === 'managedspace') {
    return com.atproto.managedspace.policy.$build({
      managingApp: policy.managingApp,
      publishPolicy: policy.publishPolicy ?? false,
    })
  }
  return com.atproto.memberspace.policy.$build({
    publicRead: policy.publicRead ?? false,
    publicWrite: policy.publicWrite ?? false,
    allowedApps: policy.allowedApps ? [...policy.allowedApps] : undefined,
    publishPolicy: policy.publishPolicy ?? false,
    publishMembers: policy.publishMembers ?? false,
  })
}

function policyFromLex(value: { $type?: string, [key: string]: unknown }): SpacePolicyDetail {
  if (value.$type === 'com.atproto.personalspace.policy')
    return { type: 'personalspace' }
  if (value.$type === 'com.atproto.managedspace.policy') {
    return {
      type: 'managedspace',
      managingApp: String(value.managingApp ?? ''),
      publishPolicy: Boolean(value.publishPolicy),
    }
  }
  return {
    type: 'memberspace',
    publicRead: Boolean(value.publicRead),
    publicWrite: Boolean(value.publicWrite),
    allowedApps: Array.isArray(value.allowedApps) ? value.allowedApps.map(String) : undefined,
    publishPolicy: Boolean(value.publishPolicy),
    publishMembers: Boolean(value.publishMembers),
  }
}

function policyInfo(uri: string, policy: SpacePolicyDetail): SpaceInfo {
  if (policy.type === 'personalspace') {
    return {
      uri,
      read: 'member-list',
      write: 'member-list',
      appAccess: 'open',
      policy,
    }
  }
  if (policy.type === 'managedspace') {
    return {
      uri,
      read: { managingApp: policy.managingApp },
      write: { managingApp: policy.managingApp },
      appAccess: 'open',
      policy,
    }
  }
  return {
    uri,
    read: policy.publicRead ? 'public' : 'member-list',
    write: policy.publicWrite ? 'public' : 'member-list',
    appAccess: policy.allowedApps?.length ? { allowed: policy.allowedApps } : 'open',
    policy,
  }
}

function policyForOptions(options: EnsureSpaceOptions, current?: SpacePolicyDetail): SpacePolicyDetail {
  if (options.policy)
    return options.policy

  const read = options.read ?? (current?.type === 'memberspace' && current.publicRead ? 'public' : current?.type === 'managedspace' ? { managingApp: current.managingApp } : 'member-list')
  const write = options.write ?? (current?.type === 'memberspace' && current.publicWrite ? 'public' : current?.type === 'managedspace' ? { managingApp: current.managingApp } : 'member-list')
  const managed = typeof read === 'object' ? read.managingApp : typeof write === 'object' ? write.managingApp : undefined
  if (managed) {
    return {
      type: 'managedspace',
      managingApp: managed,
      publishPolicy: options.publishPolicy ?? (current?.type === 'managedspace' ? current.publishPolicy : false),
    }
  }

  return {
    type: 'memberspace',
    publicRead: read === 'public',
    publicWrite: write === 'public',
    allowedApps: options.appAccess && options.appAccess !== 'open' ? [...options.appAccess.allowed] : current?.type === 'memberspace' ? current.allowedApps : undefined,
    publishPolicy: options.publishPolicy ?? (current?.type === 'memberspace' ? current.publishPolicy : false),
    publishMembers: options.publishMembers ?? (current?.type === 'memberspace' ? current.publishMembers : false),
  }
}

export interface SpaceManager {
  /**
   * Whether the authority holds a space with this type and key, from
   * `com.atproto.space.listSpaces`. A space can exist before its policy is
   * configured, in which case `info()` stays `null`.
   */
  exists: () => Promise<boolean>
  /**
   * The space's policy, or `null` when nothing has configured it. A space
   * written to without `ensure()` has no managed policy, so `info()` stays
   * `null`; use `exists()` to ask whether the space is there at all.
   */
  info: () => Promise<SpaceInfo | null>
  ensure: (options?: EnsureSpaceOptions) => Promise<SpaceInfo>
  update: (options: EnsureSpaceOptions) => Promise<SpaceInfo>
  delete: () => Promise<void>
  members: {
    list: () => Promise<SpaceMember[]>
    add: (did: DidString, access?: SpaceMemberAccess) => Promise<void>
    remove: (did: DidString) => Promise<void>
  }
  removeWriter: (did: DidString) => Promise<void>
  clearRecords: () => Promise<void>
}

/** `com.atproto.space` management for a space anchored on the session's DID. */
export function createSpaceManager(space: Space, authority: DidString, client: Client | undefined): SpaceManager {
  const uri = spaceUri(authority, space.type, space.skey)
  const require = (): Client => {
    if (!client)
      throw readOnly('manage spaces')
    return client
  }

  async function info(): Promise<SpaceInfo | null> {
    try {
      const res = await require().call(com.atproto.space.getSpace, { space: uri })
      return policyInfo(uri, policyFromLex(res.policy))
    }
    catch (err) {
      if (err instanceof XrpcResponseError && err.error === 'SpaceNotFound')
        return null
      throw err
    }
  }

  async function exists(): Promise<boolean> {
    let cursor: string | undefined
    do {
      const res = await require().call(com.atproto.space.listSpaces, { spaceType: space.type, did: authority, limit: PAGE, cursor })
      if (res.spaces.some(view => view.uri === uri))
        return true
      cursor = res.cursor
    } while (cursor)
    return false
  }

  return {
    exists,
    info,
    async ensure(options = {}) {
      const existing = await info()
      if (existing)
        return existing
      const policy = policyForOptions(options)
      const res = await require().call(com.atproto.space.createSpace, {
        spaceType: space.type,
        skey: space.skey,
        policy: policyToLex(policy),
      })
      return policyInfo(res.uri, policy)
    },
    async update(options) {
      const existing = await info()
      if (!existing)
        throw new Error(`space not found: ${uri}`)
      const policy = policyForOptions(options, existing.policy)
      await require().call(com.atproto.space.updateSpace, { space: uri, policy: policyToLex(policy) })
      return policyInfo(uri, policy)
    },
    async delete() {
      await require().call(com.atproto.space.deleteSpace, { space: uri })
    },
    members: {
      async list() {
        const out: SpaceMember[] = []
        let cursor: string | undefined
        do {
          const res = await require().call(com.atproto.memberspace.listMembers, { space: uri, limit: PAGE, cursor })
          out.push(...res.members.map(m => ({ did: m.did, read: m.read, write: m.write })))
          cursor = res.cursor
        } while (cursor)
        return out
      },
      async add(did, access = {}) {
        await require().call(com.atproto.memberspace.putMember, { space: uri, did, read: access.read ?? true, write: access.write ?? true })
      },
      async remove(did) {
        await require().call(com.atproto.memberspace.removeMember, { space: uri, did })
      },
    },
    async removeWriter(did) {
      await require().call(com.atproto.space.removeWriter, { space: uri, did })
    },
    async clearRecords() {
      await require().call(com.atproto.space.clearRecords, { space: uri, repo: authority })
    },
  }
}
