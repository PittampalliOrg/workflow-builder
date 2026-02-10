"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type PieceAuthConfig,
  type PieceAuthProperty,
  PieceAuthType,
  PiecePropertyType,
} from "@/lib/types/piece-auth";

type AuthFormValues = Record<string, unknown>;

type AuthFormRendererProps = {
  authConfig: PieceAuthConfig;
  values: AuthFormValues;
  onChange: (values: AuthFormValues) => void;
  disabled?: boolean;
};

/**
 * Renders a dynamic auth form based on piece metadata auth configuration.
 *
 * Supports:
 * - SECRET_TEXT: single password input
 * - BASIC_AUTH: username + password
 * - CUSTOM_AUTH: dynamic props (SHORT_TEXT, LONG_TEXT, NUMBER, etc.)
 * - OAUTH2: "Connect" button (OAuth flow handled externally)
 * - null/undefined: name-only (no auth fields)
 */
export function AuthFormRenderer({
  authConfig,
  values,
  onChange,
  disabled,
}: AuthFormRendererProps) {
  if (!authConfig) {
    return null;
  }

  const updateValue = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value });
  };

  switch (authConfig.type) {
    case PieceAuthType.SECRET_TEXT:
      return (
        <div className="space-y-2">
          <Label htmlFor="secret_text">
            {authConfig.displayName || "API Key"}
          </Label>
          <Input
            disabled={disabled}
            id="secret_text"
            onChange={(e) => updateValue("secret_text", e.target.value)}
            placeholder="Enter your API key"
            type="password"
            value={(values.secret_text as string) || ""}
          />
          {authConfig.description && (
            <p className="text-muted-foreground text-xs">
              {authConfig.description}
            </p>
          )}
        </div>
      );

    case PieceAuthType.BASIC_AUTH:
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">
              {authConfig.username?.displayName || "Username"}
            </Label>
            <Input
              disabled={disabled}
              id="username"
              onChange={(e) => updateValue("username", e.target.value)}
              placeholder={authConfig.username?.description || "Enter username"}
              value={(values.username as string) || ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">
              {authConfig.password?.displayName || "Password"}
            </Label>
            <Input
              disabled={disabled}
              id="password"
              onChange={(e) => updateValue("password", e.target.value)}
              placeholder={authConfig.password?.description || "Enter password"}
              type="password"
              value={(values.password as string) || ""}
            />
          </div>
          {authConfig.description && (
            <p className="text-muted-foreground text-xs">
              {authConfig.description}
            </p>
          )}
        </div>
      );

    case PieceAuthType.CUSTOM_AUTH:
      return (
        <div className="space-y-4">
          {authConfig.description && (
            <p className="text-muted-foreground text-xs">
              {authConfig.description}
            </p>
          )}
          {Object.entries(authConfig.props).map(([key, prop]) => (
            <PropertyField
              disabled={disabled}
              key={key}
              onChange={(val) => {
                const props = (values.props as Record<string, unknown>) || {};
                onChange({
                  ...values,
                  props: { ...props, [key]: val },
                });
              }}
              property={prop}
              propKey={key}
              value={(values.props as Record<string, unknown>)?.[key] ?? ""}
            />
          ))}
        </div>
      );

    case PieceAuthType.OAUTH2:
      return <OAuth2AuthForm authConfig={authConfig} disabled={disabled} />;

    default:
      return null;
  }
}

/**
 * Renders a single property field based on its type
 */
function PropertyField({
  propKey,
  property,
  value,
  onChange,
  disabled,
}: {
  propKey: string;
  property: PieceAuthProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  if (property.type === PiecePropertyType.MARKDOWN) {
    return (
      <div className="text-muted-foreground text-sm">{property.value}</div>
    );
  }

  const displayName =
    "displayName" in property ? property.displayName : propKey;
  const description = property.description;

  switch (property.type) {
    case PiecePropertyType.SHORT_TEXT:
      return (
        <div className="space-y-2">
          <Label htmlFor={propKey}>{displayName}</Label>
          <Input
            disabled={disabled}
            id={propKey}
            onChange={(e) => onChange(e.target.value)}
            placeholder={description || `Enter ${displayName.toLowerCase()}`}
            value={(value as string) || ""}
          />
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      );

    case PiecePropertyType.SECRET_TEXT:
      return (
        <div className="space-y-2">
          <Label htmlFor={propKey}>{displayName}</Label>
          <Input
            disabled={disabled}
            id={propKey}
            onChange={(e) => onChange(e.target.value)}
            placeholder={description || `Enter ${displayName.toLowerCase()}`}
            type="password"
            value={(value as string) || ""}
          />
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      );

    case PiecePropertyType.LONG_TEXT:
      return (
        <div className="space-y-2">
          <Label htmlFor={propKey}>{displayName}</Label>
          <Textarea
            disabled={disabled}
            id={propKey}
            onChange={(e) => onChange(e.target.value)}
            placeholder={description || `Enter ${displayName.toLowerCase()}`}
            rows={3}
            value={(value as string) || ""}
          />
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      );

    case PiecePropertyType.NUMBER:
      return (
        <div className="space-y-2">
          <Label htmlFor={propKey}>{displayName}</Label>
          <Input
            disabled={disabled}
            id={propKey}
            onChange={(e) => onChange(Number(e.target.value))}
            placeholder={description || `Enter ${displayName.toLowerCase()}`}
            type="number"
            value={value !== undefined ? String(value) : ""}
          />
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      );

    case PiecePropertyType.CHECKBOX:
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            checked={!!value}
            disabled={disabled}
            id={propKey}
            onCheckedChange={(checked) => onChange(checked)}
          />
          <Label className="cursor-pointer" htmlFor={propKey}>
            {displayName}
          </Label>
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      );

    case PiecePropertyType.STATIC_DROPDOWN:
      return (
        <div className="space-y-2">
          <Label htmlFor={propKey}>{displayName}</Label>
          <Select
            disabled={disabled}
            onValueChange={(val) => onChange(val)}
            value={(value as string) || undefined}
          >
            <SelectTrigger id={propKey}>
              <SelectValue
                placeholder={
                  property.options?.placeholder ||
                  `Select ${displayName.toLowerCase()}`
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(property.options?.options || []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      );

    default:
      return (
        <div className="space-y-2">
          <Label htmlFor={propKey}>{displayName}</Label>
          <Input
            disabled={disabled}
            id={propKey}
            onChange={(e) => onChange(e.target.value)}
            placeholder={description || `Enter ${displayName.toLowerCase()}`}
            value={(value as string) || ""}
          />
        </div>
      );
  }
}

/**
 * OAuth2 auth form - shows a "Connect" button that initiates the OAuth flow
 */
function OAuth2AuthForm({
  authConfig,
  disabled,
}: {
  authConfig: Extract<
    NonNullable<PieceAuthConfig>,
    { type: typeof PieceAuthType.OAUTH2 }
  >;
  disabled?: boolean;
}) {
  const [connecting, setConnecting] = useState(false);

  const handleConnect = () => {
    setConnecting(true);
    // OAuth2 flow will be handled by the parent component
    // via the oauth2/start API endpoint
    // For now, show that the flow would be initiated
    setTimeout(() => setConnecting(false), 1000);
  };

  return (
    <div className="space-y-4">
      {authConfig.description && (
        <p className="text-muted-foreground text-xs">
          {authConfig.description}
        </p>
      )}

      {/* Render any additional OAuth2 props (e.g., server URL) */}
      {authConfig.props &&
        Object.entries(authConfig.props).map(([key, prop]) => (
          <PropertyField
            disabled={disabled}
            key={key}
            onChange={() => {}}
            property={prop}
            propKey={key}
            value=""
          />
        ))}

      <Button
        className="w-full"
        disabled={disabled || connecting}
        onClick={handleConnect}
        type="button"
        variant="outline"
      >
        {connecting ? "Connecting..." : "Connect with OAuth2"}
      </Button>

      <p className="text-muted-foreground text-xs">
        Scopes: {authConfig.scope?.join(", ") || "none"}
      </p>
    </div>
  );
}
