import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * Testing Library unmounts after each test by itself only when the framework's
 * hooks are globals, and this suite imports them by name instead. Without this
 * the second render of a component would find the first still in the document,
 * and every `getBy*` would fail on the duplicate rather than on the behaviour.
 */
afterEach(cleanup)
