import { PRIMARY_OUTLET, type Router } from '@angular/router';

/** Sign-in may restore an internal deep link, never another host or sign-in itself. */
export function safeReturnUrl(router: Router, value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value))
    return '/';
  try {
    const tree = router.parseUrl(value);
    if (tree.root.children[PRIMARY_OUTLET]?.segments[0]?.path === 'login') return '/';
    return router.serializeUrl(tree);
  } catch {
    return '/';
  }
}
