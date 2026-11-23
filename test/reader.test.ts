import type { TestPds } from './pds.ts'
import { createDidResolver } from '@atproto-labs/did-resolver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAirspace, defineCollection, defineSpace } from '../src/index.ts'
import { workspace as declaration, project, projectCategory } from './fixtures/lex.ts'
import { startTestPds } from './pds.ts'

const projects = defineCollection(project)
const categories = defineCollection(projectCategory)
const ownerSpace = defineSpace(declaration, { collections: { projects, categories } })

let pds: TestPds
beforeAll(async () => {
  pds = await startTestPds()
})
afterAll(() => pds.close())

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable)
    items.push(item)
  return items
}

describe('space reader', () => {
  it('reads another member\'s repo with a space credential', async () => {
    const owner = await pds.account()
    const member = await pds.account()

    const ownerAirspace = createAirspace({
      identity: { did: owner.did, service: pds.service },
      spaces: { workspace: ownerSpace },
      session: owner.session,
    })
    await ownerAirspace.workspace.manage.ensure()
    await ownerAirspace.workspace.manage.members.add(member.did)

    const now = new Date().toISOString()
    const category = await ownerAirspace.workspace.categories.create({ name: 'Category', createdAt: now })
    const draft = await ownerAirspace.workspace.projects.create({
      name: 'Owner draft',
      category: { uri: category.uri, cid: category.cid },
      createdAt: now,
    })

    const memberSpace = defineSpace(declaration, {
      authority: owner.did,
      collections: { projects, categories },
    })
    const memberAirspace = createAirspace({
      identity: { did: member.did, service: pds.service },
      spaces: { workspace: memberSpace },
      session: member.session,
    })

    const reader = await memberAirspace.workspace.reader({
      didResolver: createDidResolver({ plcDirectoryUrl: pds.plc }),
    })

    expect(reader.uri).toBe(`at://${owner.did}/space/dev.example.workspace/self`)
    expect(await collect(reader.writers())).toContainEqual(expect.objectContaining({ repo: owner.did }))

    const listed = await reader.listRecords({ repo: owner.did, collection: 'dev.example.project' })
    expect(listed.body.records.map(record => record.value)).toContainEqual(expect.objectContaining({ name: 'Owner draft' }))

    const fetched = await reader.getRecord('dev.example.project', draft.rkey, { repo: owner.did })
    expect(fetched.body.value).toEqual(expect.objectContaining({ name: 'Owner draft' }))
  })
})
