export { authConfigSchema } from './config';
export { authGuard } from './guard';
export { RegistrationWindow } from './registration';
export { authRoutes, REFRESH_COOKIE } from './routes';
export { AccountExistsError, AuthStore } from './store';

export type { AuthConfig, AuthConfigInput } from './config';
export type { AuthenticatedContext } from './guard';
export type { AuthRoutesOptions } from './routes';
export type { Account, Authenticated, AuthStoreOptions, TokenPair } from './store';
