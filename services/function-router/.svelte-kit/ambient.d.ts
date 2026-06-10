
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const SHELL: string;
	export const LSCOLORS: string;
	export const npm_command: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const __ETC_PROFILE_DONE: string;
	export const GHOSTTY_BIN_DIR: string;
	export const I3PM_SCOPE: string;
	export const npm_config_userconfig: string;
	export const COLORTERM: string;
	export const __HM_SESS_VARS_SOURCED: string;
	export const I3PM_EXECUTION_MODE: string;
	export const HERDR_PANE_ID: string;
	export const XDG_CONFIG_DIRS: string;
	export const npm_config_cache: string;
	export const I3PM_WORKTREE_REPO: string;
	export const LESS: string;
	export const GREP_COLOR: string;
	export const _ZO_DOCTOR: string;
	export const TERM_PROGRAM_VERSION: string;
	export const WLR_NO_HARDWARE_CURSORS: string;
	export const I3PM_LAUNCHER_PID: string;
	export const I3PM_MONITORING_CLICKHOUSE_TIMEOUT: string;
	export const AI_AGENT: string;
	export const I3PM_REMOTE_DIR: string;
	export const CLAUDE_CODE_SESSION_ID: string;
	export const I3SOCK: string;
	export const NODE: string;
	export const LESS_TERMCAP_se: string;
	export const I3PM_LAUNCH_TIME: string;
	export const LESS_TERMCAP_so: string;
	export const LC_ADDRESS: string;
	export const LC_NAME: string;
	export const SSH_AUTH_SOCK: string;
	export const NODE_EXTRA_CA_CERTS: string;
	export const XDG_DATA_HOME: string;
	export const CLAUDE_EFFORT: string;
	export const I3PM_TRANSPORT_KIND: string;
	export const XDG_CONFIG_HOME: string;
	export const TPM2_PKCS11_TCTI: string;
	export const XCURSOR_PATH: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const I3PM_WORKTREE_ACCOUNT: string;
	export const COLOR: string;
	export const LOCALE_ARCHIVE_2_27: string;
	export const npm_config_local_prefix: string;
	export const LIBVA_DRIVER_NAME: string;
	export const LC_MONETARY: string;
	export const GDK_PIXBUF_MODULE_FILE: string;
	export const I3PM_REMOTE_USER: string;
	export const NO_AT_BRIDGE: string;
	export const XCURSOR_SIZE: string;
	export const npm_config_globalconfig: string;
	export const I3PM_PROJECT_DISPLAY_NAME: string;
	export const EDITOR: string;
	export const FZF_ALT_C_OPTS: string;
	export const I3PM_MONITORING_CLICKHOUSE_USER: string;
	export const XDG_SEAT: string;
	export const PWD: string;
	export const NIX_PROFILES: string;
	export const I3PM_APP_NAME: string;
	export const LOGNAME: string;
	export const OP_SERVICE_ACCOUNT_TOKEN: string;
	export const XDG_SESSION_TYPE: string;
	export const OP_BIOMETRIC_UNLOCK_ENABLED: string;
	export const CUPS_DATADIR: string;
	export const NIX_PATH: string;
	export const npm_config_init_module: string;
	export const SYSTEMD_EXEC_PID: string;
	export const NIXPKGS_CONFIG: string;
	export const GREP_OPTIONS: string;
	export const TPM2TOOLS_TCTI: string;
	export const I3PM_REMOTE_HOST: string;
	export const FZF_TMUX: string;
	export const MOZ_ALLOW_ADDON_SIDELOAD: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const FZF_DEFAULT_COMMAND: string;
	export const UV_PYTHON: string;
	export const I3PM_TERMINAL_ROLE: string;
	export const TERMINAL: string;
	export const I3PM_PROJECT_ICON: string;
	export const CLAUDECODE: string;
	export const GI_TYPELIB_PATH: string;
	export const GHOSTTY_SHELL_FEATURES: string;
	export const HOME: string;
	export const GITKRAKEN_USE_SYSTEM_GIT: string;
	export const SSH_ASKPASS: string;
	export const DEFAULT_BROWSER: string;
	export const LANG: string;
	export const LC_PAPER: string;
	export const NIXOS_OZONE_WL: string;
	export const TMUX_TMPDIR: string;
	export const LS_COLORS: string;
	export const _JAVA_AWT_WM_NONREPARENTING: string;
	export const FZF_CTRL_R_OPTS: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const NH_FLAKE: string;
	export const I3PM_CONTEXT_KEY: string;
	export const npm_package_version: string;
	export const OP_DEVICE: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const STARSHIP_SHELL: string;
	export const SWAYSOCK: string;
	export const WAYLAND_DISPLAY: string;
	export const STARSHIP_CONFIG: string;
	export const I3PM_REMOTE_PORT: string;
	export const GIO_EXTRA_MODULES: string;
	export const I3PM_TERMINAL_ANCHOR_ID: string;
	export const CLICOLOR: string;
	export const I3PM_TARGET_HOST: string;
	export const MANAGERPID: string;
	export const INIT_CWD: string;
	export const GTK_A11Y: string;
	export const STARSHIP_SESSION_KEY: string;
	export const QT_QPA_PLATFORM: string;
	export const I3PM_PROJECT_NAME: string;
	export const XDG_CACHE_HOME: string;
	export const NIX_USER_PROFILE_DIR: string;
	export const INFOPATH: string;
	export const npm_lifecycle_script: string;
	export const I3PM_REMOTE_ENABLED: string;
	export const USE_BUILTIN_RIPGREP: string;
	export const npm_config_npm_version: string;
	export const GHOSTTY_RESOURCES_DIR: string;
	export const I3PM_CONTEXT_VARIANT: string;
	export const GITKRAKEN_SSH_AUTH_SOCK: string;
	export const I3PM_TMUX_SESSION_NAME: string;
	export const VSCODE_SSH_AUTH_SOCK: string;
	export const LC_IDENTIFICATION: string;
	export const TERM: string;
	export const TERMINFO: string;
	export const LESS_TERMCAP_mb: string;
	export const npm_package_name: string;
	export const DISABLE_INSTALLATION_CHECKS: string;
	export const FZF_CTRL_T_COMMAND: string;
	export const LESS_TERMCAP_me: string;
	export const GTK_PATH: string;
	export const LESS_TERMCAP_md: string;
	export const npm_config_prefix: string;
	export const I3PM_PROJECT_DIR: string;
	export const CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: string;
	export const USER: string;
	export const CLAUDE_CODE_ENABLE_TELEMETRY: string;
	export const SDL_VIDEODRIVER: string;
	export const FZF_ALT_C_COMMAND: string;
	export const ELECTRON_FORCE_IS_PACKAGED: string;
	export const PLASMA_USE_QT_SCALING: string;
	export const TZDIR: string;
	export const FZF_CTRL_T_OPTS: string;
	export const VISUAL: string;
	export const DISPLAY: string;
	export const npm_lifecycle_event: string;
	export const SHLVL: string;
	export const LESS_TERMCAP_ue: string;
	export const MOZ_ENABLE_WAYLAND: string;
	export const GEMINI_MODEL: string;
	export const I3PM_TARGET_WORKSPACE: string;
	export const LESS_TERMCAP_us: string;
	export const GIT_EDITOR: string;
	export const PAGER: string;
	export const UV_PYTHON_PREFERENCE: string;
	export const LC_TELEPHONE: string;
	export const QTWEBKIT_PLUGIN_PATH: string;
	export const LC_MEASUREMENT: string;
	export const __NIXOS_SET_ENVIRONMENT_DONE: string;
	export const XDG_VTNR: string;
	export const OPENSHELL_GATEWAY: string;
	export const I3PM_REMOTE_SESSION_NAME: string;
	export const XDG_SESSION_ID: string;
	export const I3PM_LOCAL_HOST_ALIAS: string;
	export const LOCALE_ARCHIVE: string;
	export const MANAGERPIDFDID: string;
	export const I3PM_EXPECTED_CLASS: string;
	export const LESSKEYIN_SYSTEM: string;
	export const npm_config_user_agent: string;
	export const QML2_IMPORT_PATH: string;
	export const TERMINFO_DIRS: string;
	export const XDG_STATE_HOME: string;
	export const npm_execpath: string;
	export const I3PM_APP_ID: string;
	export const LD_LIBRARY_PATH: string;
	export const DISABLE_AUTOUPDATER: string;
	export const NIX_REMOTE: string;
	export const NH_OS_FLAKE: string;
	export const XDG_RUNTIME_DIR: string;
	export const SSL_CERT_FILE: string;
	export const I3PM_CONNECTION_KEY: string;
	export const NODE_PATH: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const I3PM_WORKTREE_BRANCH: string;
	export const NIX_XDG_DESKTOP_PORTAL_DIR: string;
	export const REQUESTS_CA_BUNDLE: string;
	export const LC_TIME: string;
	export const DOCKER_HOST: string;
	export const npm_package_json: string;
	export const QT_AUTO_SCREEN_SCALE_FACTOR: string;
	export const HERDR_ENV: string;
	export const XDG_DATA_DIRS: string;
	export const LIBEXEC_PATH: string;
	export const CLAUDE_CODE_EXECPATH: string;
	export const BROWSER: string;
	export const npm_config_noproxy: string;
	export const PATH: string;
	export const LIBSECRET_BACKEND: string;
	export const __GLX_VENDOR_LIBRARY_NAME: string;
	export const LANGFUSE_ENABLED: string;
	export const npm_config_node_gyp: string;
	export const FLAKE_ROOT: string;
	export const QT_ENABLE_HIGHDPI_SCALING: string;
	export const GBM_BACKEND: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const I3PM_ACTIVE: string;
	export const FZF_DEFAULT_OPTS: string;
	export const npm_config_global_prefix: string;
	export const HERDR_SOCKET_PATH: string;
	export const I3PM_LOCAL_PROJECT_DIR: string;
	export const I3PM_MONITORING_CLICKHOUSE_URL: string;
	export const _SWAY_WRAPPER_ALREADY_EXECUTED: string;
	export const QT_PLUGIN_PATH: string;
	export const _JAVA_OPTIONS: string;
	export const I3PM_MONITORING_CLICKHOUSE_PASSWORD: string;
	export const npm_node_execpath: string;
	export const GIT_CREDENTIAL_HELPER_GITHUB: string;
	export const LC_NUMERIC: string;
	export const TERM_PROGRAM: string;
	export const CLAUDE_CODE_WORKFLOWS: string;
	export const TEST: string;
	export const VITEST: string;
	export const NODE_ENV: string;
	export const PROD: string;
	export const DEV: string;
	export const BASE_URL: string;
	export const MODE: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		SHELL: string;
		LSCOLORS: string;
		npm_command: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		__ETC_PROFILE_DONE: string;
		GHOSTTY_BIN_DIR: string;
		I3PM_SCOPE: string;
		npm_config_userconfig: string;
		COLORTERM: string;
		__HM_SESS_VARS_SOURCED: string;
		I3PM_EXECUTION_MODE: string;
		HERDR_PANE_ID: string;
		XDG_CONFIG_DIRS: string;
		npm_config_cache: string;
		I3PM_WORKTREE_REPO: string;
		LESS: string;
		GREP_COLOR: string;
		_ZO_DOCTOR: string;
		TERM_PROGRAM_VERSION: string;
		WLR_NO_HARDWARE_CURSORS: string;
		I3PM_LAUNCHER_PID: string;
		I3PM_MONITORING_CLICKHOUSE_TIMEOUT: string;
		AI_AGENT: string;
		I3PM_REMOTE_DIR: string;
		CLAUDE_CODE_SESSION_ID: string;
		I3SOCK: string;
		NODE: string;
		LESS_TERMCAP_se: string;
		I3PM_LAUNCH_TIME: string;
		LESS_TERMCAP_so: string;
		LC_ADDRESS: string;
		LC_NAME: string;
		SSH_AUTH_SOCK: string;
		NODE_EXTRA_CA_CERTS: string;
		XDG_DATA_HOME: string;
		CLAUDE_EFFORT: string;
		I3PM_TRANSPORT_KIND: string;
		XDG_CONFIG_HOME: string;
		TPM2_PKCS11_TCTI: string;
		XCURSOR_PATH: string;
		MEMORY_PRESSURE_WRITE: string;
		I3PM_WORKTREE_ACCOUNT: string;
		COLOR: string;
		LOCALE_ARCHIVE_2_27: string;
		npm_config_local_prefix: string;
		LIBVA_DRIVER_NAME: string;
		LC_MONETARY: string;
		GDK_PIXBUF_MODULE_FILE: string;
		I3PM_REMOTE_USER: string;
		NO_AT_BRIDGE: string;
		XCURSOR_SIZE: string;
		npm_config_globalconfig: string;
		I3PM_PROJECT_DISPLAY_NAME: string;
		EDITOR: string;
		FZF_ALT_C_OPTS: string;
		I3PM_MONITORING_CLICKHOUSE_USER: string;
		XDG_SEAT: string;
		PWD: string;
		NIX_PROFILES: string;
		I3PM_APP_NAME: string;
		LOGNAME: string;
		OP_SERVICE_ACCOUNT_TOKEN: string;
		XDG_SESSION_TYPE: string;
		OP_BIOMETRIC_UNLOCK_ENABLED: string;
		CUPS_DATADIR: string;
		NIX_PATH: string;
		npm_config_init_module: string;
		SYSTEMD_EXEC_PID: string;
		NIXPKGS_CONFIG: string;
		GREP_OPTIONS: string;
		TPM2TOOLS_TCTI: string;
		I3PM_REMOTE_HOST: string;
		FZF_TMUX: string;
		MOZ_ALLOW_ADDON_SIDELOAD: string;
		NoDefaultCurrentDirectoryInExePath: string;
		FZF_DEFAULT_COMMAND: string;
		UV_PYTHON: string;
		I3PM_TERMINAL_ROLE: string;
		TERMINAL: string;
		I3PM_PROJECT_ICON: string;
		CLAUDECODE: string;
		GI_TYPELIB_PATH: string;
		GHOSTTY_SHELL_FEATURES: string;
		HOME: string;
		GITKRAKEN_USE_SYSTEM_GIT: string;
		SSH_ASKPASS: string;
		DEFAULT_BROWSER: string;
		LANG: string;
		LC_PAPER: string;
		NIXOS_OZONE_WL: string;
		TMUX_TMPDIR: string;
		LS_COLORS: string;
		_JAVA_AWT_WM_NONREPARENTING: string;
		FZF_CTRL_R_OPTS: string;
		XDG_CURRENT_DESKTOP: string;
		NH_FLAKE: string;
		I3PM_CONTEXT_KEY: string;
		npm_package_version: string;
		OP_DEVICE: string;
		MEMORY_PRESSURE_WATCH: string;
		STARSHIP_SHELL: string;
		SWAYSOCK: string;
		WAYLAND_DISPLAY: string;
		STARSHIP_CONFIG: string;
		I3PM_REMOTE_PORT: string;
		GIO_EXTRA_MODULES: string;
		I3PM_TERMINAL_ANCHOR_ID: string;
		CLICOLOR: string;
		I3PM_TARGET_HOST: string;
		MANAGERPID: string;
		INIT_CWD: string;
		GTK_A11Y: string;
		STARSHIP_SESSION_KEY: string;
		QT_QPA_PLATFORM: string;
		I3PM_PROJECT_NAME: string;
		XDG_CACHE_HOME: string;
		NIX_USER_PROFILE_DIR: string;
		INFOPATH: string;
		npm_lifecycle_script: string;
		I3PM_REMOTE_ENABLED: string;
		USE_BUILTIN_RIPGREP: string;
		npm_config_npm_version: string;
		GHOSTTY_RESOURCES_DIR: string;
		I3PM_CONTEXT_VARIANT: string;
		GITKRAKEN_SSH_AUTH_SOCK: string;
		I3PM_TMUX_SESSION_NAME: string;
		VSCODE_SSH_AUTH_SOCK: string;
		LC_IDENTIFICATION: string;
		TERM: string;
		TERMINFO: string;
		LESS_TERMCAP_mb: string;
		npm_package_name: string;
		DISABLE_INSTALLATION_CHECKS: string;
		FZF_CTRL_T_COMMAND: string;
		LESS_TERMCAP_me: string;
		GTK_PATH: string;
		LESS_TERMCAP_md: string;
		npm_config_prefix: string;
		I3PM_PROJECT_DIR: string;
		CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: string;
		USER: string;
		CLAUDE_CODE_ENABLE_TELEMETRY: string;
		SDL_VIDEODRIVER: string;
		FZF_ALT_C_COMMAND: string;
		ELECTRON_FORCE_IS_PACKAGED: string;
		PLASMA_USE_QT_SCALING: string;
		TZDIR: string;
		FZF_CTRL_T_OPTS: string;
		VISUAL: string;
		DISPLAY: string;
		npm_lifecycle_event: string;
		SHLVL: string;
		LESS_TERMCAP_ue: string;
		MOZ_ENABLE_WAYLAND: string;
		GEMINI_MODEL: string;
		I3PM_TARGET_WORKSPACE: string;
		LESS_TERMCAP_us: string;
		GIT_EDITOR: string;
		PAGER: string;
		UV_PYTHON_PREFERENCE: string;
		LC_TELEPHONE: string;
		QTWEBKIT_PLUGIN_PATH: string;
		LC_MEASUREMENT: string;
		__NIXOS_SET_ENVIRONMENT_DONE: string;
		XDG_VTNR: string;
		OPENSHELL_GATEWAY: string;
		I3PM_REMOTE_SESSION_NAME: string;
		XDG_SESSION_ID: string;
		I3PM_LOCAL_HOST_ALIAS: string;
		LOCALE_ARCHIVE: string;
		MANAGERPIDFDID: string;
		I3PM_EXPECTED_CLASS: string;
		LESSKEYIN_SYSTEM: string;
		npm_config_user_agent: string;
		QML2_IMPORT_PATH: string;
		TERMINFO_DIRS: string;
		XDG_STATE_HOME: string;
		npm_execpath: string;
		I3PM_APP_ID: string;
		LD_LIBRARY_PATH: string;
		DISABLE_AUTOUPDATER: string;
		NIX_REMOTE: string;
		NH_OS_FLAKE: string;
		XDG_RUNTIME_DIR: string;
		SSL_CERT_FILE: string;
		I3PM_CONNECTION_KEY: string;
		NODE_PATH: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		I3PM_WORKTREE_BRANCH: string;
		NIX_XDG_DESKTOP_PORTAL_DIR: string;
		REQUESTS_CA_BUNDLE: string;
		LC_TIME: string;
		DOCKER_HOST: string;
		npm_package_json: string;
		QT_AUTO_SCREEN_SCALE_FACTOR: string;
		HERDR_ENV: string;
		XDG_DATA_DIRS: string;
		LIBEXEC_PATH: string;
		CLAUDE_CODE_EXECPATH: string;
		BROWSER: string;
		npm_config_noproxy: string;
		PATH: string;
		LIBSECRET_BACKEND: string;
		__GLX_VENDOR_LIBRARY_NAME: string;
		LANGFUSE_ENABLED: string;
		npm_config_node_gyp: string;
		FLAKE_ROOT: string;
		QT_ENABLE_HIGHDPI_SCALING: string;
		GBM_BACKEND: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		I3PM_ACTIVE: string;
		FZF_DEFAULT_OPTS: string;
		npm_config_global_prefix: string;
		HERDR_SOCKET_PATH: string;
		I3PM_LOCAL_PROJECT_DIR: string;
		I3PM_MONITORING_CLICKHOUSE_URL: string;
		_SWAY_WRAPPER_ALREADY_EXECUTED: string;
		QT_PLUGIN_PATH: string;
		_JAVA_OPTIONS: string;
		I3PM_MONITORING_CLICKHOUSE_PASSWORD: string;
		npm_node_execpath: string;
		GIT_CREDENTIAL_HELPER_GITHUB: string;
		LC_NUMERIC: string;
		TERM_PROGRAM: string;
		CLAUDE_CODE_WORKFLOWS: string;
		TEST: string;
		VITEST: string;
		NODE_ENV: string;
		PROD: string;
		DEV: string;
		BASE_URL: string;
		MODE: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
