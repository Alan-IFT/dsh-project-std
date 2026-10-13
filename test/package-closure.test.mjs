import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const selftest = readFileSync(join(root, 'lib', 'selftest_shared.js'), 'utf8')

test('package files closes the shared-fact template and its license notice', () => {
  const template = 'templates/WORK_ITEM.md'
  assert.ok(selftest.includes("'templates', 'WORK_ITEM.md'"), 'shared selftest must keep its exact template read')
  assert.ok(pkg.files.includes(template), `files must include ${template}`)
  assert.ok(pkg.files.includes('LICENSE-DOCS'), 'files must include the documentation license notice')
  assert.ok(existsSync(resolve(root, template)), `${template} must exist`)
  const license = readFileSync(join(root, 'LICENSE-DOCS'), 'utf8')
  const scope = license.split(/\r?\n/, 1)[0]
  assert.match(scope, /templates\//)
  assert.match(scope, /CC BY 4\.0/i)
})
