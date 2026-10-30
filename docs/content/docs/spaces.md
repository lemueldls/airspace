# spaces

Anything in your repo is public straight away, which is no good for drafts. A [permissioned space](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data) is a private area of the same repo, using the same collections and schemas.

> [!WARNING]
> Spaces are experimental. They need a PDS running prerelease software: atproto's `permissioned-data` branch, or the `@atproto/pds` [spaces alpha](https://atproto.com/blog/atproto-spaces-alpha). Hosted PDSes, including `bsky.social`, do not support them yet. The API may change.

## drafting and publishing

Declare a space with `space([...])` and `defineSpace`, as in [your content model](/docs/model). Its collections then have the same API public ones do:

```ts
const draft = await airspace.workspace.projects.create({ name: 'Not public yet', category: ref, createdAt: now })

await airspace.workspace.projects.publish(draft.rkey) // copies to the public repo at the same key
await airspace.workspace.projects.publish(draft.rkey, { transform: value => ({ ...value, publishedAt: now }) })
await airspace.workspace.projects.publish(draft.rkey, { ifMatch: draft.cid })

await airspace.workspace.projects.publish(draft.rkey, { move: true }) // and drop the draft
await airspace.workspace.projects.publish(draft.rkey, { to: airspace.review.projects }) // into another space instead
await airspace.projects.delete(draft.rkey) // unpublish

const live = await airspace.workspace.projects.published() // keys that exist in both
await airspace.workspace.supported() // false on most PDSes today, needs no session
```

A published copy is identical to its draft, down to the content hash, so `ifMatch: draft.cid` means "only if nobody has edited the public record since". Pointers between drafts are stored as plain AT URIs, so a published copy keeps them.

`to` takes another client of the same collection, in this airspace: publishing `projects` into `categories` throws. Space writes take no swap parameter, so `ifMatch` with a space target throws too. `move` is a write followed by a delete rather than one operation, and nothing rolls the write back if the delete fails. A draft edited while the write is in flight is kept, and `move` throws [`ConflictError`](/docs/errors).

Without support, a space call throws [`SpacesUnsupportedError`](/docs/errors).

## managing a space

`airspace.workspace.manage` creates a space and sets its policy. A space has one `policy`, not separate read and write policies:

```ts
import type { SpacePolicyDetail } from 'airspace'

const policy: SpacePolicyDetail = {
  type: 'memberspace',
  publicRead: false,
  publicWrite: false,
  publishMembers: true,
}

await airspace.workspace.manage.ensure({ policy })
await airspace.workspace.manage.update({ policy: { ...policy, publicRead: true } })
await airspace.workspace.manage.members.add(did) // read and write, unless you pass { read, write }
await airspace.workspace.manage.members.list() // [{ did, read, write }]
await airspace.workspace.manage.removeWriter(did) // drop the repo from listRepos
await airspace.workspace.manage.clearRecords() // empty this account's repo in the space

await airspace.workspace.manage.exists() // is the space there at all?
await airspace.workspace.manage.info() // `null` until `ensure()`
```

The `read`, `write`, and `appAccess` options map onto the current policy:

```ts
await airspace.workspace.manage.ensure({
  read: 'member-list',
  write: 'member-list',
  appAccess: 'open',
  publishMembers: true,
})
```

`type: 'memberspace'` is the shared-space policy. Set `publicRead` or `publicWrite` to open that side to anyone. `publishPolicy` and `publishMembers` write the policy and member list into the authority's space repo so readers and syncers can discover them. The other normalized types are `personalspace` (only the authority) and `managedspace` (each access decision goes to a managing app). Their wire types are `com.atproto.personalspace.policy` and `com.atproto.managedspace.policy`.

Call `ensure()` before writing. The current alpha creates the space and its repo together, so a write does not create an unconfigured space as a side effect.

Over OAuth each operation is a separate grant, asked for with `manage` in [`scopesFor`](/docs/oauth): `update()`, `members.add()`, `members.remove()`, and `removeWriter()` need `update`, and `delete()` needs `delete`.

> [!WARNING]
> Blobs uploaded into a space are currently readable through the public `sync.getBlob` endpoint ([atproto#5435](https://github.com/bluesky-social/atproto/issues/5435)). Don't put images in a space that you'd mind being seen.
