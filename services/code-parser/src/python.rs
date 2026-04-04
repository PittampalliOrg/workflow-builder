use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use rustpython_parser::{
    ast::{
        self, Constant, Expr, ExprAttribute, ExprBinOp, ExprCall, ExprConstant, ExprName,
        Operator, Stmt, StmtAnnAssign, StmtAsyncFunctionDef, StmtClassDef, StmtFunctionDef,
        Suite,
    },
    Parse,
};
use serde_json::{json, Value};

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
    args: ast::Arguments,
    returns: Option<Box<Expr>>,
    body: Vec<Stmt>,
}

pub fn parse_python(
    source: &str,
    entrypoint: Option<&str>,
    path: Option<&str>,
    supporting_files: &HashMap<String, String>,
) -> Result<CodeFunctionModel> {
    let module = Suite::parse(source, path.unwrap_or("main.py"))
        .map_err(|error| anyhow!("failed to parse python source: {error}"))?;
    let supporting_modules = supporting_files
        .iter()
        .filter_map(|(supporting_path, contents)| {
            Suite::parse(contents, supporting_path)
                .ok()
                .map(|suite| (supporting_path.clone(), suite))
        })
        .collect::<Vec<_>>();
    let entrypoint = entrypoint.unwrap_or("main");

    let function = find_function(&module, entrypoint)
        .with_context(|| format!("python entrypoint `{entrypoint}` was not found"))?;
    let descriptions = extract_param_docs(&function.body);
    let imports = collect_imports(&module, path, &supporting_modules);
    let class_index = build_class_index(&module, &supporting_modules);

    let mut params = build_params(&function.args, &descriptions, &class_index)?;
    let metadata = parse_metadata(source);
    apply_metadata(&mut params, &metadata);
    let return_type = function
        .returns
        .as_ref()
        .map(|expr| parse_type(expr, &class_index))
        .unwrap_or_else(SemanticType::unknown);

    Ok(CodeFunctionModel {
        language: Language::Python,
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

fn find_function(module: &[Stmt], entrypoint: &str) -> Option<FunctionDef> {
    for statement in module {
        match statement {
            Stmt::FunctionDef(StmtFunctionDef { name, args, returns, body, .. })
                if name.as_str() == entrypoint =>
            {
                return Some(FunctionDef {
                    name: name.to_string(),
                    is_async: false,
                    args: (*args.clone()),
                    returns: returns.clone(),
                    body: body.clone(),
                });
            }
            Stmt::AsyncFunctionDef(StmtAsyncFunctionDef {
                name, args, returns, body, ..
            }) if name.as_str() == entrypoint => {
                return Some(FunctionDef {
                    name: name.to_string(),
                    is_async: true,
                    args: (*args.clone()),
                    returns: returns.clone(),
                    body: body.clone(),
                });
            }
            _ => {}
        }
    }
    None
}

fn build_params(
    args: &ast::Arguments,
    descriptions: &HashMap<String, String>,
    class_index: &HashMap<String, SemanticType>,
) -> Result<Vec<SemanticParam>> {
    let default_start = args.args.len().saturating_sub(args.defaults().count());
    let mut params = Vec::new();

    for (index, arg) in args.args.iter().enumerate() {
        let annotation = arg.as_arg().annotation.as_ref();
        let mut type_model = annotation
            .map(|annotation| parse_type(annotation, class_index))
            .unwrap_or_else(SemanticType::unknown);

        let default_value = if index >= default_start {
            args.defaults()
                .nth(index - default_start)
                .and_then(parse_default)
        } else {
            None
        };

        if matches!(type_model.kind, SemanticTypeKind::Unknown) {
            if let Some(default) = &default_value {
                type_model = infer_type_from_value(default);
            }
        }

        let schema = type_to_schema(&type_model);
        params.push(SemanticParam {
            name: arg.as_arg().arg.to_string(),
            required: default_value.is_none(),
            description: descriptions.get(arg.as_arg().arg.as_str()).cloned(),
            default_value,
            dynamic_input: None,
            type_model,
            schema,
        });
    }

    Ok(params)
}

fn build_class_index(
    module: &[Stmt],
    supporting_modules: &[(String, Suite)],
) -> HashMap<String, SemanticType> {
    let mut index = HashMap::new();

    for statement in module {
        collect_class_statement(statement, &mut index);
    }
    for (_, supporting_module) in supporting_modules {
        for statement in supporting_module {
            collect_class_statement(statement, &mut index);
        }
    }

    index
}

fn collect_class_statement(statement: &Stmt, index: &mut HashMap<String, SemanticType>) {
    if let Stmt::ClassDef(StmtClassDef {
        name, body, bases, decorator_list, ..
    }) = statement
    {
        let is_model =
            bases.iter().any(is_base_model) || decorator_list.iter().any(is_dataclass_decorator);

        if !is_model {
            return;
        }

        let mut properties = Vec::new();
        for class_stmt in body {
            if let Stmt::AnnAssign(StmtAnnAssign { target, annotation, value, .. }) = class_stmt {
                if let Expr::Name(ExprName { id, .. }) = target.as_ref() {
                    let mut prop_type = parse_type(annotation, index);
                    if matches!(prop_type.kind, SemanticTypeKind::Unknown) {
                        if let Some(default) = value.as_ref().and_then(|expr| parse_default(expr.as_ref()))
                        {
                            prop_type = infer_type_from_value(&default);
                        }
                    }
                    properties.push(SemanticProperty {
                        name: id.to_string(),
                        type_model: prop_type,
                        required: value.is_none(),
                        description: None,
                    });
                }
            }
        }

        index.insert(
            name.to_string(),
            SemanticType::object(Some(name.to_string()), properties, false),
        );
    }
}

fn parse_resource_type(expr: &Expr) -> Option<SemanticType> {
    let Expr::Subscript(subscript) = expr else {
        return None;
    };
    let Expr::Name(ExprName { id, .. }) = subscript.value.as_ref() else {
        return None;
    };
    if !matches!(id.as_str(), "Resource" | "Connection" | "AppConnection") {
        return None;
    }
    let resource_type = match subscript.slice.as_ref() {
        Expr::Constant(ExprConstant { value: Constant::Str(value), .. }) => value.to_string(),
        _ => return None,
    };
    let mut semantic = SemanticType::string(false);
    semantic.resource_type = Some(resource_type);
    semantic.original = Some(id.to_string());
    Some(semantic)
}

fn is_base_model(expr: &Expr) -> bool {
    match expr {
        Expr::Name(ExprName { id, .. }) => id.as_str() == "BaseModel",
        Expr::Attribute(ExprAttribute { value, attr, .. }) => {
            attr.as_str() == "BaseModel"
                && matches!(value.as_ref(), Expr::Name(ExprName { id, .. }) if id.as_str() == "pydantic")
        }
        _ => false,
    }
}

fn is_dataclass_decorator(expr: &Expr) -> bool {
    match expr {
        Expr::Name(ExprName { id, .. }) => id.as_str() == "dataclass",
        Expr::Attribute(ExprAttribute { value, attr, .. }) => {
            attr.as_str() == "dataclass"
                && matches!(value.as_ref(), Expr::Name(ExprName { id, .. }) if id.as_str() == "dataclasses" || id.as_str() == "pydantic")
        }
        Expr::Call(ExprCall { func, .. }) => is_dataclass_decorator(func.as_ref()),
        _ => false,
    }
}

fn parse_type(expr: &Expr, class_index: &HashMap<String, SemanticType>) -> SemanticType {
    if let Some(resource_type) = parse_resource_type(expr) {
        return resource_type;
    }

    match expr {
        Expr::Name(ExprName { id, .. }) => match id.as_str() {
            "str" | "String" => SemanticType::string(false),
            "int" | "float" => SemanticType::number(false),
            "bool" => SemanticType::boolean(false),
            "dict" | "Dict" => SemanticType::object(None, vec![], false),
            "Any" => SemanticType::unknown(),
            other => class_index
                .get(other)
                .cloned()
                .unwrap_or_else(|| SemanticType::unknown_named(other)),
        },
        Expr::Subscript(subscript) => {
            if let Expr::Name(ExprName { id, .. }) = subscript.value.as_ref() {
                match id.as_str() {
                    "list" | "List" => {
                        return SemanticType::array(parse_type(subscript.slice.as_ref(), class_index), false)
                    }
                    "Optional" => {
                        let mut inner = parse_type(subscript.slice.as_ref(), class_index);
                        inner.nullable = true;
                        return inner;
                    }
                    "Literal" => {
                        let values = match subscript.slice.as_ref() {
                            Expr::Tuple(tuple) => tuple
                                .elts
                                .iter()
                                .filter_map(parse_default)
                                .collect::<Vec<_>>(),
                            single => parse_default(single).into_iter().collect(),
                        };
                        return SemanticType::enumeration(values, false);
                    }
                    _ => {}
                }
            }
            SemanticType::unknown()
        }
        Expr::BinOp(ExprBinOp { left, op, right, .. }) if matches!(op, Operator::BitOr) => {
            let left_type = parse_type(left, class_index);
            let right_type = parse_type(right, class_index);
            if right_type.kind == SemanticTypeKind::Null {
                let mut left_type = left_type;
                left_type.nullable = true;
                return left_type;
            }
            if left_type.kind == SemanticTypeKind::Null {
                let mut right_type = right_type;
                right_type.nullable = true;
                return right_type;
            }
            SemanticType::union(vec![left_type, right_type], false)
        }
        Expr::Constant(ExprConstant { value, .. }) => match value {
            Constant::None => SemanticType::null(),
            Constant::Bool(_) => SemanticType::boolean(false),
            Constant::Int(_) | Constant::Float(_) => SemanticType::number(false),
            Constant::Str(_) => SemanticType::string(false),
            _ => SemanticType::unknown(),
        },
        _ => SemanticType::unknown(),
    }
}

fn parse_default(expr: &Expr) -> Option<Value> {
    match expr {
        Expr::Constant(ExprConstant { value, .. }) => match value {
            Constant::None => Some(Value::Null),
            Constant::Bool(value) => Some(Value::Bool(*value)),
            Constant::Int(value) => Some(json!(value.to_string().parse::<i64>().ok()?)),
            Constant::Float(value) => Some(json!(value)),
            Constant::Str(value) => Some(Value::String(value.to_string())),
            _ => None,
        },
        Expr::List(list) => Some(Value::Array(
            list.elts.iter().filter_map(parse_default).collect::<Vec<_>>(),
        )),
        Expr::Dict(dict) => {
            let mut map = serde_json::Map::new();
            for (key, value) in dict.keys.iter().zip(dict.values.iter()) {
                let Some(key) = key
                    .as_ref()
                    .and_then(parse_default)
                    .and_then(|value| value.as_str().map(str::to_owned))
                else {
                    continue;
                };
                let Some(value) = parse_default(value) else {
                    continue;
                };
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

fn collect_imports(
    module: &[Stmt],
    path: Option<&str>,
    supporting_modules: &[(String, Suite)],
) -> Vec<ImportRef> {
    let mut imports = parse_imports(module, path);
    for (supporting_path, supporting_module) in supporting_modules {
        imports.extend(parse_imports(supporting_module, Some(supporting_path)));
    }
    dedupe_imports(imports)
}

fn parse_imports(module: &[Stmt], path: Option<&str>) -> Vec<ImportRef> {
    let mut imports = Vec::new();
    for statement in module {
        match statement {
            Stmt::Import(import_stmt) => {
                for alias in &import_stmt.names {
                    imports.push(to_import_ref(alias.name.to_string(), path));
                }
            }
            Stmt::ImportFrom(import_from) => {
                let prefix = ".".repeat(
                    import_from
                        .level
                        .map(|level| level.to_usize())
                        .unwrap_or_default(),
                );
                let module_name = import_from
                    .module
                    .as_ref()
                    .map(|module| module.to_string())
                    .unwrap_or_default();
                let specifier = format!("{prefix}{module_name}");
                imports.push(to_import_ref(specifier, path));
            }
            _ => {}
        }
    }
    imports
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

fn to_import_ref(specifier: String, path: Option<&str>) -> ImportRef {
    let is_relative = specifier.starts_with('.');
    ImportRef {
        resolved_path: if is_relative {
            resolve_python_relative_path(path, &specifier)
        } else {
            None
        },
        kind: if is_relative {
            ImportKind::Local
        } else {
            ImportKind::External
        },
        specifier,
    }
}

fn resolve_python_relative_path(path: Option<&str>, specifier: &str) -> Option<String> {
    let path = path?;
    let (directory, _) = path.rsplit_once('/')?;
    let depth = specifier.chars().take_while(|ch| *ch == '.').count();
    let suffix = specifier.trim_start_matches('.');
    let mut segments = directory
        .split('/')
        .map(str::to_owned)
        .collect::<Vec<_>>();

    for _ in 0..depth.saturating_sub(1) {
        segments.pop();
    }

    if !suffix.is_empty() {
        segments.extend(suffix.split('.').map(str::to_owned));
    }

    Some(segments.join("/"))
}

fn extract_param_docs(body: &[Stmt]) -> HashMap<String, String> {
    let mut docs = HashMap::new();
    let Some(Stmt::Expr(expr_stmt)) = body.first() else {
        return docs;
    };
    let Expr::Constant(ExprConstant { value: Constant::Str(docstring), .. }) = expr_stmt.value.as_ref() else {
        return docs;
    };

    let mut in_args = false;
    for line in docstring.lines() {
        let trimmed = line.trim();
        if trimmed == "Args:" {
            in_args = true;
            continue;
        }
        if !in_args || trimmed.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && trimmed.ends_with(':') {
            break;
        }
        if let Some((name, description)) = trimmed.split_once(':') {
            let key = name.split('(').next().unwrap_or(name).trim().to_string();
            docs.insert(key, description.trim().to_string());
        }
    }
    docs
}
