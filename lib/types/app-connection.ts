export type AppConnectionId = string;

export enum AppConnectionStatus {
  ACTIVE = "ACTIVE",
  MISSING = "MISSING",
  ERROR = "ERROR",
}

export enum AppConnectionScope {
  PROJECT = "PROJECT",
  PLATFORM = "PLATFORM",
}

export enum AppConnectionType {
  OAUTH2 = "OAUTH2",
  PLATFORM_OAUTH2 = "PLATFORM_OAUTH2",
  CLOUD_OAUTH2 = "CLOUD_OAUTH2",
  SECRET_TEXT = "SECRET_TEXT",
  BASIC_AUTH = "BASIC_AUTH",
  CUSTOM_AUTH = "CUSTOM_AUTH",
  NO_AUTH = "NO_AUTH",
}

export enum OAuth2AuthorizationMethod {
  HEADER = "HEADER",
  BODY = "BODY",
}

export enum OAuth2GrantType {
  AUTHORIZATION_CODE = "authorization_code",
  CLIENT_CREDENTIALS = "client_credentials",
}

export type SecretTextConnectionValue = {
  type: AppConnectionType.SECRET_TEXT;
  secret_text: string;
};

export type BasicAuthConnectionValue = {
  type: AppConnectionType.BASIC_AUTH;
  username: string;
  password: string;
};

export type BaseOAuth2ConnectionValue = {
  expires_in?: number;
  client_id: string;
  token_type: string;
  access_token: string;
  claimed_at: number;
  refresh_token: string;
  scope: string;
  token_url: string;
  authorization_method?: OAuth2AuthorizationMethod;
  data: Record<string, unknown>;
  props?: Record<string, unknown>;
  grant_type?: OAuth2GrantType;
};

export type OAuth2ConnectionValueWithApp = BaseOAuth2ConnectionValue & {
  type: AppConnectionType.OAUTH2;
  client_secret: string;
  redirect_url: string;
};

export type OAuth2ConnectionValueWithCode = {
  type: AppConnectionType.OAUTH2;
  client_id: string;
  client_secret: string;
  redirect_url: string;
  code: string;
  scope: string;
  props?: Record<string, unknown>;
  authorization_method?: OAuth2AuthorizationMethod;
  code_challenge?: string;
  grant_type?: OAuth2GrantType;
};

export type CloudOAuth2ConnectionValue = BaseOAuth2ConnectionValue & {
  type: AppConnectionType.CLOUD_OAUTH2;
};

export type PlatformOAuth2ConnectionValue = BaseOAuth2ConnectionValue & {
  type: AppConnectionType.PLATFORM_OAUTH2;
  redirect_url: string;
};

export type CustomAuthConnectionValue<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  type: AppConnectionType.CUSTOM_AUTH;
  props: T;
};

export type NoAuthConnectionValue = {
  type: AppConnectionType.NO_AUTH;
};

export type AppConnectionValue =
  | SecretTextConnectionValue
  | BasicAuthConnectionValue
  | OAuth2ConnectionValueWithApp
  | CloudOAuth2ConnectionValue
  | PlatformOAuth2ConnectionValue
  | CustomAuthConnectionValue
  | NoAuthConnectionValue;

export type AppConnection = {
  id: string;
  externalId: string;
  type: AppConnectionType;
  scope: AppConnectionScope;
  pieceName: string;
  displayName: string;
  projectIds: string[];
  platformId: string | null;
  status: AppConnectionStatus;
  ownerId: string | null;
  value: AppConnectionValue;
  metadata: Record<string, unknown> | null;
  pieceVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type AppConnectionWithoutSensitiveData = Omit<AppConnection, "value">;

type CommonConnectionRequestFields = {
  externalId: string;
  displayName: string;
  pieceName: string;
  projectId: string;
  metadata?: Record<string, unknown> | null;
  pieceVersion?: string;
};

export type UpsertSecretTextRequest = CommonConnectionRequestFields & {
  type: AppConnectionType.SECRET_TEXT;
  value: SecretTextConnectionValue;
};

export type UpsertBasicAuthRequest = CommonConnectionRequestFields & {
  type: AppConnectionType.BASIC_AUTH;
  value: BasicAuthConnectionValue;
};

export type UpsertCustomAuthRequest = CommonConnectionRequestFields & {
  type: AppConnectionType.CUSTOM_AUTH;
  value: CustomAuthConnectionValue;
};

export type UpsertNoAuthRequest = CommonConnectionRequestFields & {
  type: AppConnectionType.NO_AUTH;
  value: NoAuthConnectionValue;
};

export type UpsertOAuth2Request = CommonConnectionRequestFields & {
  type: AppConnectionType.OAUTH2;
  value: OAuth2ConnectionValueWithCode | OAuth2ConnectionValueWithApp;
};

export type UpsertCloudOAuth2Request = CommonConnectionRequestFields & {
  type: AppConnectionType.CLOUD_OAUTH2;
  value:
    | {
        type: AppConnectionType.CLOUD_OAUTH2;
        client_id: string;
        code: string;
        scope: string;
        props?: Record<string, unknown>;
        authorization_method?: OAuth2AuthorizationMethod;
        code_challenge?: string;
      }
    | CloudOAuth2ConnectionValue;
};

export type UpsertPlatformOAuth2Request = CommonConnectionRequestFields & {
  type: AppConnectionType.PLATFORM_OAUTH2;
  value:
    | {
        type: AppConnectionType.PLATFORM_OAUTH2;
        client_id: string;
        redirect_url: string;
        code: string;
        scope: string;
        props?: Record<string, unknown>;
        authorization_method?: OAuth2AuthorizationMethod;
        code_challenge?: string;
      }
    | PlatformOAuth2ConnectionValue;
};

export type UpsertAppConnectionRequestBody =
  | UpsertSecretTextRequest
  | UpsertBasicAuthRequest
  | UpsertCustomAuthRequest
  | UpsertNoAuthRequest
  | UpsertOAuth2Request
  | UpsertCloudOAuth2Request
  | UpsertPlatformOAuth2Request;

export type UpdateConnectionValueRequestBody = {
  displayName: string;
  metadata?: Record<string, unknown> | null;
};

export type ListAppConnectionsRequestQuery = {
  cursor?: string;
  projectId: string;
  scope?: AppConnectionScope;
  pieceName?: string;
  displayName?: string;
  status?: AppConnectionStatus[];
  limit?: number;
};
