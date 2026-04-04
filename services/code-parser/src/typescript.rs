use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use swc_common::{sync::Lrc, FileName, SourceMap, Spanned};
use swc_ecma_ast::{
    Decl, Expr, FnDecl, Function, ImportDecl, Lit, Module, ModuleDecl, ModuleItem, Pat,
    TsEntityName, TsFnOrConstructorType, TsInterfaceBody, TsInterfaceDecl, TsKeywordType,
    TsKeywordTypeKind, TsLit, TsLitType, TsPropertySignature, TsTupleType, TsType, TsTypeAliasDecl,
    TsTypeElement, TsTypeLit, TsTypeOperatorOp, TsTypeRef, TsUnionOrIntersectionType, TsUnionType,
    VarDecl, VarDeclarator,
};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};

use crate::{
    metadata::{apply_metadata, parse_metadata},
    model::{
        CapabilityFlags, CodeFunctionModel, ImportKind, ImportRef, Language, SemanticParam,
        SemanticProperty, SemanticType, SemanticTypeKind,
    },
    schema::{params_to_input_schema, type_to_schema},
};

#[derive(Clone)]
struct FunctionDef {
    name: String,
    is_async: bool,
    function: Box<Function>,
}

#[derive(Clone)]
enum NamedTypeDecl {
    Interface(TsInterfaceDecl),
    Alias(TsTypeAliasDecl),
}

pub fn parse_typescript(
    source: &str,
    entrypoint: Option<&str>,
    path: Option<&str>,
    supporting_files: &HashMap<String, String>,
) -> Result<CodeFunctionModel> {
    let module = parse_module(source, path)?;
    let supporting_modules = supporting_files
        .iter()
        .filter_map(|(supporting_path, contents)| {
            parse_module(contents, Some(supporting_path))
                .ok()
                .map(|module| (supporting_path.clone(), module))
        })
        .collect::<Vec<_>>();
    let entrypoint = entrypoint.unwrap_or("main");
    let function = find_function(&module, entrypoint)
        .with_context(|| format!("typescript entrypoint `{entrypoint}` was not found"))?;
    let types = collect_named_types(&module, &supporting_modules);
    let imports = collect_imports(&module, path, &supporting_modules);
    let mut params = function
        .function
        .params
        .iter()
        .map(|param| parse_param(&param.pat, &types))
        .collect::<Result<Vec<_>>>()?;
    let metadata = parse_metadata(source);
    apply_metadata(&mut params, &metadata);
    let return_type = function
        .function
        .return_type
        .as_ref()
        .map(|annotation| parse_type(&annotation.type_ann, &types))
        .unwrap_or_else(SemanticType::unknown);

    Ok(CodeFunctionModel {
        language: Language::Typescript,
        entrypoint: function.name,
        is_async: function.is_async,
        imports: imports.clone(),
        params: params.clone(),
        dynamic_inputs: metadata.dynamic_inputs.clone(),
        return_type: return_type.clone(),
        schema: params_to_input_schema(&params),
        diagnostics: vec![],
        capabilities: CapabilityFlags {
            has_enums: params.iter().any(|param| param.type_model.has_enums()),
            has_nested_objects: params.iter().any(|param| param.type_model.has_nested_objects()),
            has_nullable_types: params.iter().any(|param| param.type_model.has_nullable()),
            has_relative_imports: imports.iter().any(|import| matches!(import.kind, ImportKind::Local)),
            has_resource_types: params.iter().any(|param| param.type_model.has_resource_types()),
            has_dynamic_inputs: !metadata.dynamic_inputs.is_empty(),
        },
    })
}

fn parse_module(source: &str, path: Option<&str>) -> Result<Module> {
    let cm: Lrc<SourceMap> = Default::default();
    let file_name = path.unwrap_or("main.ts").to_string();
    let fm = cm.new_source_file(FileName::Custom(file_name).into(), source.to_string());
    let syntax = Syntax::Typescript(TsSyntax {
        tsx: true,
        decorators: true,
        no_early_errors: true,
        ..Default::default()
    });
    let lexer = Lexer::new(syntax, Default::default(), StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    parser
        .parse_module()
        .map_err(|error| anyhow!("failed to parse typescript source: {error:?}"))
}

fn find_function(module: &Module, entrypoint: &str) -> Option<FunctionDef> {
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => match &export_decl.decl {
                Decl::Fn(fn_decl) if fn_decl.ident.sym.as_ref() == entrypoint => {
                    return Some(from_fn_decl(fn_decl));
                }
                Decl::Var(var_decl) => {
                    if let Some(found) = find_in_var_decl(var_decl, entrypoint) {
                        return Some(found);
                    }
                }
                _ => {}
            },
            ModuleItem::Stmt(stmt) => match stmt {
                swc_ecma_ast::Stmt::Decl(Decl::Fn(fn_decl))
                    if fn_decl.ident.sym.as_ref() == entrypoint =>
                {
                    return Some(from_fn_decl(fn_decl));
                }
                swc_ecma_ast::Stmt::Decl(Decl::Var(var_decl)) => {
                    if let Some(found) = find_in_var_decl(var_decl, entrypoint) {
                        return Some(found);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    None
}

fn from_fn_decl(fn_decl: &FnDecl) -> FunctionDef {
    FunctionDef {
        name: fn_decl.ident.sym.to_string(),
        is_async: fn_decl.function.is_async,
        function: fn_decl.function.clone(),
    }
}

fn find_in_var_decl(var_decl: &VarDecl, entrypoint: &str) -> Option<FunctionDef> {
    for declarator in &var_decl.decls {
        let VarDeclarator { name, init, .. } = declarator;
        let Pat::Ident(ident) = name else {
            continue;
        };
        if ident.id.sym.as_ref() != entrypoint {
            continue;
        }
        let init = init.as_ref()?;
        match init.as_ref() {
            Expr::Arrow(arrow) => {
                let function = Box::new(Function {
                    params: arrow
                        .params
                        .iter()
                        .cloned()
                        .map(|pat| swc_ecma_ast::Param {
                            span: pat.span(),
                            decorators: vec![],
                            pat,
                        })
                        .collect(),
                    decorators: vec![],
                    span: arrow.span,
                    ctxt: Default::default(),
                    body: None,
                    is_generator: arrow.is_generator,
                    is_async: arrow.is_async,
                    type_params: arrow.type_params.clone(),
                    return_type: arrow.return_type.clone(),
                });
                return Some(FunctionDef {
                    name: entrypoint.to_string(),
                    is_async: arrow.is_async,
                    function,
                });
            }
            Expr::Fn(fn_expr) => {
                return Some(FunctionDef {
                    name: entrypoint.to_string(),
                    is_async: fn_expr.function.is_async,
                    function: fn_expr.function.clone(),
                });
            }
            _ => {}
        }
    }
    None
}

fn collect_named_types(
    module: &Module,
    supporting_modules: &[(String, Module)],
) -> HashMap<String, NamedTypeDecl> {
    let mut types = HashMap::new();
    for item in &module.body {
        collect_named_type_from_item(item, &mut types);
    }
    for (_, supporting_module) in supporting_modules {
        for item in &supporting_module.body {
            collect_named_type_from_item(item, &mut types);
        }
    }
    types
}

fn collect_named_type_from_item(item: &ModuleItem, types: &mut HashMap<String, NamedTypeDecl>) {
    match item {
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => match &export_decl.decl {
            Decl::TsInterface(interface) => {
                types.insert(interface.id.sym.to_string(), NamedTypeDecl::Interface(*interface.clone()));
            }
            Decl::TsTypeAlias(alias) => {
                types.insert(alias.id.sym.to_string(), NamedTypeDecl::Alias(*alias.clone()));
            }
            _ => {}
        },
        ModuleItem::Stmt(swc_ecma_ast::Stmt::Decl(Decl::TsInterface(interface))) => {
            types.insert(interface.id.sym.to_string(), NamedTypeDecl::Interface(*interface.clone()));
        }
        ModuleItem::Stmt(swc_ecma_ast::Stmt::Decl(Decl::TsTypeAlias(alias))) => {
            types.insert(alias.id.sym.to_string(), NamedTypeDecl::Alias(*alias.clone()));
        }
        _ => {}
    }
}

fn parse_resource_type_ref(type_ref: &TsTypeRef) -> Option<SemanticType> {
    let TsEntityName::Ident(ident) = &type_ref.type_name else {
        return None;
    };
    if !matches!(ident.sym.as_ref(), "Resource" | "Connection" | "AppConnection") {
        return None;
    }
    let type_params = type_ref.type_params.as_ref()?;
    let first = type_params.params.first()?;
    let resource_type = match first.as_ref() {
        TsType::TsLitType(TsLitType { lit: TsLit::Str(value), .. }) => value.value.to_string(),
        _ => return None,
    };
    let mut semantic = SemanticType::string(false);
    semantic.resource_type = Some(resource_type);
    semantic.original = Some(ident.sym.to_string());
    Some(semantic)
}

fn collect_imports(
    module: &Module,
    path: Option<&str>,
    supporting_modules: &[(String, Module)],
) -> Vec<ImportRef> {
    let mut imports = parse_imports(module, path);
    for (supporting_path, supporting_module) in supporting_modules {
        imports.extend(parse_imports(supporting_module, Some(supporting_path)));
    }
    dedupe_imports(imports)
}

fn parse_imports(module: &Module, path: Option<&str>) -> Vec<ImportRef> {
    module
        .body
        .iter()
        .filter_map(|item| match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl { src, .. })) => {
                let specifier = src.value.to_string();
                Some(ImportRef {
                    resolved_path: if is_relative_import(&specifier) {
                        resolve_relative_path(path, &specifier)
                    } else {
                        None
                    },
                    kind: if is_relative_import(&specifier) {
                        ImportKind::Local
                    } else {
                        ImportKind::External
                    },
                    specifier,
                })
            }
            _ => None,
        })
        .collect()
}

fn dedupe_imports(imports: Vec<ImportRef>) -> Vec<ImportRef> {
    let mut deduped = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for import in imports {
        let key = format!(
            "{}|{:?}|{}",
            import.specifier,
            import.kind,
            import.resolved_path.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            deduped.push(import);
        }
    }

    deduped
}

fn parse_param(pat: &Pat, types: &HashMap<String, NamedTypeDecl>) -> Result<SemanticParam> {
    match pat {
        Pat::Ident(binding) => {
            let type_model = binding
                .type_ann
                .as_ref()
                .map(|annotation| parse_type(&annotation.type_ann, types))
                .unwrap_or_else(SemanticType::unknown);
            Ok(SemanticParam {
                name: binding.id.sym.to_string(),
                required: !binding.id.optional,
                description: None,
                default_value: None,
                dynamic_input: None,
                schema: type_to_schema(&type_model),
                type_model,
            })
        }
        Pat::Assign(assign) => {
            let Pat::Ident(binding) = assign.left.as_ref() else {
                return Err(anyhow!("unsupported default parameter pattern"));
            };
            let mut type_model = binding
                .type_ann
                .as_ref()
                .map(|annotation| parse_type(&annotation.type_ann, types))
                .unwrap_or_else(SemanticType::unknown);
            let default_value = parse_default(assign.right.as_ref());
            if matches!(type_model.kind, SemanticTypeKind::Unknown) {
                if let Some(default) = &default_value {
                    type_model = infer_type_from_value(default);
                }
            }
            Ok(SemanticParam {
                name: binding.id.sym.to_string(),
                required: false,
                description: None,
                default_value,
                dynamic_input: None,
                schema: type_to_schema(&type_model),
                type_model,
            })
        }
        _ => Err(anyhow!("unsupported parameter pattern")),
    }
}

fn parse_type(ts_type: &TsType, types: &HashMap<String, NamedTypeDecl>) -> SemanticType {
    match ts_type {
        TsType::TsKeywordType(TsKeywordType { kind, .. }) => match kind {
            TsKeywordTypeKind::TsStringKeyword => SemanticType::string(false),
            TsKeywordTypeKind::TsNumberKeyword | TsKeywordTypeKind::TsBigIntKeyword => {
                SemanticType::number(false)
            }
            TsKeywordTypeKind::TsBooleanKeyword => SemanticType::boolean(false),
            TsKeywordTypeKind::TsNullKeyword | TsKeywordTypeKind::TsUndefinedKeyword => SemanticType::null(),
            TsKeywordTypeKind::TsObjectKeyword => SemanticType::object(None, vec![], false),
            _ => SemanticType::unknown(),
        },
        TsType::TsArrayType(array) => SemanticType::array(parse_type(&array.elem_type, types), false),
        TsType::TsTupleType(TsTupleType { elem_types, .. }) => SemanticType::array(
            elem_types
                .first()
                .map(|elem| parse_type(&elem.ty, types))
                .unwrap_or_else(SemanticType::unknown),
            false,
        ),
        TsType::TsTypeLit(TsTypeLit { members, .. }) => {
            let properties = members
                .iter()
                .filter_map(|member| match member {
                    TsTypeElement::TsPropertySignature(TsPropertySignature { key, type_ann, optional, .. }) => {
                        let Expr::Ident(ident) = key.as_ref() else {
                            return None;
                        };
                        Some(SemanticProperty {
                            name: ident.sym.to_string(),
                            type_model: type_ann
                                .as_ref()
                                .map(|annotation| parse_type(&annotation.type_ann, types))
                                .unwrap_or_else(SemanticType::unknown),
                            required: !optional,
                            description: None,
                        })
                    }
                    _ => None,
                })
                .collect();
            SemanticType::object(None, properties, false)
        }
        TsType::TsUnionOrIntersectionType(TsUnionOrIntersectionType::TsUnionType(
            TsUnionType { types: variants, .. },
        )) => {
            if variants.iter().all(|variant| is_literal_type(variant.as_ref())) {
                SemanticType::enumeration(
                    variants
                        .iter()
                        .filter_map(|variant| literal_type_to_value(variant.as_ref()))
                        .collect::<Vec<_>>(),
                    false,
                )
            } else {
                let mut parsed = variants
                    .iter()
                    .map(|variant| parse_type(variant, types))
                    .collect::<Vec<_>>();
                let nullable = parsed.iter().any(|variant| variant.kind == SemanticTypeKind::Null);
                parsed.retain(|variant| variant.kind != SemanticTypeKind::Null);
                if parsed.len() == 1 {
                    let mut only = parsed.remove(0);
                    only.nullable = only.nullable || nullable;
                    only
                } else {
                    SemanticType::union(parsed, nullable)
                }
            }
        }
        TsType::TsLitType(TsLitType { lit, .. }) => match lit {
            TsLit::Str(value) => SemanticType::enumeration(vec![Value::String(value.value.to_string())], false),
            TsLit::Number(value) => SemanticType::enumeration(vec![json!(value.value)], false),
            TsLit::Bool(value) => SemanticType::enumeration(vec![Value::Bool(value.value)], false),
            _ => SemanticType::unknown(),
        },
        TsType::TsTypeRef(type_ref) => parse_resource_type_ref(type_ref)
            .unwrap_or_else(|| match &type_ref.type_name {
                TsEntityName::Ident(ident) => match ident.sym.as_ref() {
                    "Array" => {
                        if let Some(type_params) = &type_ref.type_params {
                            if let Some(first) = type_params.params.first() {
                                return SemanticType::array(parse_type(first, types), false);
                            }
                        }
                        SemanticType::array(SemanticType::unknown(), false)
                    }
                    "Promise" => {
                        if let Some(type_params) = &type_ref.type_params {
                            if let Some(first) = type_params.params.first() {
                                return parse_type(first, types);
                            }
                        }
                        SemanticType::unknown_named("Promise")
                    }
                    other => resolve_named_type(other, types),
                },
                _ => SemanticType::unknown(),
            }),
        TsType::TsParenthesizedType(parenthesized) => parse_type(&parenthesized.type_ann, types),
        TsType::TsOptionalType(optional) => {
            let mut inner = parse_type(&optional.type_ann, types);
            inner.nullable = true;
            inner
        }
        TsType::TsFnOrConstructorType(TsFnOrConstructorType::TsFnType(_)) => SemanticType::unknown_named("function"),
        TsType::TsTypeOperator(operator) if matches!(operator.op, TsTypeOperatorOp::ReadOnly) => {
            parse_type(&operator.type_ann, types)
        }
        _ => SemanticType::unknown(),
    }
}

fn resolve_named_type(name: &str, types: &HashMap<String, NamedTypeDecl>) -> SemanticType {
    match types.get(name) {
        Some(NamedTypeDecl::Interface(interface)) => {
            SemanticType::object(Some(name.to_string()), interface_properties(&interface.body, types), false)
        }
        Some(NamedTypeDecl::Alias(alias)) => {
            let mut resolved = parse_type(&alias.type_ann, types);
            if resolved.name.is_none() {
                resolved.name = Some(name.to_string());
            }
            resolved
        }
        None => SemanticType::unknown_named(name),
    }
}

fn interface_properties(body: &TsInterfaceBody, types: &HashMap<String, NamedTypeDecl>) -> Vec<SemanticProperty> {
    body.body
        .iter()
        .filter_map(|member| match member {
            TsTypeElement::TsPropertySignature(TsPropertySignature { key, type_ann, optional, .. }) => {
                let Expr::Ident(ident) = key.as_ref() else {
                    return None;
                };
                Some(SemanticProperty {
                    name: ident.sym.to_string(),
                    type_model: type_ann
                        .as_ref()
                        .map(|annotation| parse_type(&annotation.type_ann, types))
                        .unwrap_or_else(SemanticType::unknown),
                    required: !optional,
                    description: None,
                })
            }
            _ => None,
        })
        .collect()
}

fn parse_default(expr: &Expr) -> Option<Value> {
    match expr {
        Expr::Lit(Lit::Str(value)) => Some(Value::String(value.value.to_string())),
        Expr::Lit(Lit::Num(value)) => Some(json!(value.value)),
        Expr::Lit(Lit::Bool(value)) => Some(Value::Bool(value.value)),
        Expr::Lit(Lit::Null(..)) => Some(Value::Null),
        Expr::Array(array) => Some(Value::Array(
            array
                .elems
                .iter()
                .filter_map(|elem| elem.as_ref())
                .filter_map(|elem| parse_default(&elem.expr))
                .collect(),
        )),
        Expr::Object(object) => {
            let mut map = serde_json::Map::new();
            for property in &object.props {
                let swc_ecma_ast::PropOrSpread::Prop(prop) = property else {
                    continue;
                };
                let swc_ecma_ast::Prop::KeyValue(key_value) = prop.as_ref() else {
                    continue;
                };
                let key = match &key_value.key {
                    swc_ecma_ast::PropName::Ident(ident) => ident.sym.to_string(),
                    swc_ecma_ast::PropName::Str(value) => value.value.to_string(),
                    _ => continue,
                };
                let value = parse_default(&key_value.value)?;
                map.insert(key, value);
            }
            Some(Value::Object(map))
        }
        _ => None,
    }
}

fn infer_type_from_value(value: &Value) -> SemanticType {
    match value {
        Value::Null => SemanticType::null(),
        Value::Bool(_) => SemanticType::boolean(false),
        Value::Number(_) => SemanticType::number(false),
        Value::String(_) => SemanticType::string(false),
        Value::Array(values) => SemanticType::array(
            values
                .first()
                .map(infer_type_from_value)
                .unwrap_or_else(SemanticType::unknown),
            false,
        ),
        Value::Object(map) => SemanticType::object(
            None,
            map.iter()
                .map(|(name, value)| SemanticProperty {
                    name: name.clone(),
                    type_model: infer_type_from_value(value),
                    required: true,
                    description: None,
                })
                .collect(),
            false,
        ),
    }
}

fn is_literal_type(ts_type: &TsType) -> bool {
    matches!(ts_type, TsType::TsLitType(..))
}

fn literal_type_to_value(ts_type: &TsType) -> Option<Value> {
    match ts_type {
        TsType::TsLitType(TsLitType { lit, .. }) => match lit {
            TsLit::Str(value) => Some(Value::String(value.value.to_string())),
            TsLit::Number(value) => Some(json!(value.value)),
            TsLit::Bool(value) => Some(Value::Bool(value.value)),
            _ => None,
        },
        _ => None,
    }
}

fn is_relative_import(specifier: &str) -> bool {
    specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/')
}

fn resolve_relative_path(path: Option<&str>, specifier: &str) -> Option<String> {
    let path = path?;
    let (directory, _) = path.rsplit_once('/')?;
    let mut segments = directory.split('/').collect::<Vec<_>>();
    for part in specifier.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    Some(segments.join("/"))
}
