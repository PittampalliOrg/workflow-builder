use serde_json::{Map, Value};

use crate::model::{SemanticProperty, SemanticType, SemanticTypeKind};

pub fn type_to_schema(typ: &SemanticType) -> Value {
    let mut schema = match typ.kind {
        SemanticTypeKind::String => json_type("string"),
        SemanticTypeKind::Number => json_type("number"),
        SemanticTypeKind::Boolean => json_type("boolean"),
        SemanticTypeKind::Array => {
            let mut map = Map::new();
            map.insert("type".into(), Value::String("array".into()));
            map.insert(
                "items".into(),
                typ.item_type
                    .as_ref()
                    .map(|item| type_to_schema(item))
                    .unwrap_or_else(|| json_type("object")),
            );
            Value::Object(map)
        }
        SemanticTypeKind::Object => object_schema(&typ.properties),
        SemanticTypeKind::Enum => {
            let mut map = Map::new();
            map.insert("type".into(), Value::String("string".into()));
            map.insert("enum".into(), Value::Array(typ.enum_values.clone()));
            Value::Object(map)
        }
        SemanticTypeKind::Union => {
            let variants = typ
                .variants
                .iter()
                .map(type_to_schema)
                .collect::<Vec<_>>();
            let mut map = Map::new();
            map.insert("oneOf".into(), Value::Array(variants));
            Value::Object(map)
        }
        SemanticTypeKind::Null => json_type("null"),
        SemanticTypeKind::Unknown => json_type("object"),
    };

    if let Some(Value::Object(map)) = schema.as_object_mut().map(|m| Value::Object(m.clone())) {
        let _ = map;
    }

    if let Value::Object(map) = &mut schema {
        if let Some(name) = &typ.name {
            map.insert("title".into(), Value::String(name.clone()));
        }
        if let Some(resource_type) = &typ.resource_type {
            map.insert("format".into(), Value::String(format!("resource-{resource_type}")));
            map.insert("x-resource-type".into(), Value::String(resource_type.clone()));
        }
        if typ.nullable {
            if let Some(schema_type) = map.get_mut("type") {
                match schema_type {
                    Value::String(existing) => {
                        *schema_type =
                            Value::Array(vec![Value::String(existing.clone()), Value::String("null".into())]);
                    }
                    Value::Array(values) => {
                        if !values.contains(&Value::String("null".into())) {
                            values.push(Value::String("null".into()));
                        }
                    }
                    _ => {}
                }
            } else if let Some(one_of) = map.get_mut("oneOf") {
                if let Value::Array(values) = one_of {
                    values.push(json_type("null"));
                }
            }
        }
    }

    schema
}

pub fn params_to_input_schema(params: &[crate::model::SemanticParam]) -> Value {
    let mut map = Map::new();
    let mut properties = Map::new();
    let mut required = Vec::new();

    map.insert("type".into(), Value::String("object".into()));

    for param in params {
        let mut param_schema = param.schema.clone();
        if let Value::Object(inner) = &mut param_schema {
            if let Some(description) = &param.description {
                inner.insert("description".into(), Value::String(description.clone()));
            }
            if let Some(default_value) = &param.default_value {
                inner.insert("default".into(), default_value.clone());
            }
            if let Some(dynamic_input) = &param.dynamic_input {
                let mut extension = Map::new();
                extension.insert("handler".into(), Value::String(dynamic_input.handler.clone()));
                if !dynamic_input.depends_on.is_empty() {
                    extension.insert(
                        "dependsOn".into(),
                        Value::Array(
                            dynamic_input
                                .depends_on
                                .iter()
                                .map(|item| Value::String(item.clone()))
                                .collect(),
                        ),
                    );
                }
                if dynamic_input.search {
                    extension.insert("search".into(), Value::Bool(true));
                }
                inner.insert("x-dynamic-input".into(), Value::Object(extension));
            }
        }
        properties.insert(param.name.clone(), param_schema);
        if param.required {
            required.push(Value::String(param.name.clone()));
        }
    }

    map.insert("properties".into(), Value::Object(properties));
    if !required.is_empty() {
        map.insert("required".into(), Value::Array(required));
    }

    Value::Object(map)
}

fn object_schema(properties: &[SemanticProperty]) -> Value {
    let mut map = Map::new();
    let mut props = Map::new();
    let mut required = Vec::new();

    map.insert("type".into(), Value::String("object".into()));

    for property in properties {
        let mut prop_schema = type_to_schema(&property.type_model);
        if let Some(description) = &property.description {
            if let Value::Object(inner) = &mut prop_schema {
                inner.insert("description".into(), Value::String(description.clone()));
            }
        }
        props.insert(property.name.clone(), prop_schema);
        if property.required {
            required.push(Value::String(property.name.clone()));
        }
    }

    map.insert("properties".into(), Value::Object(props));
    if !required.is_empty() {
        map.insert("required".into(), Value::Array(required));
    }

    Value::Object(map)
}

fn json_type(kind: &str) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), Value::String(kind.into()));
    Value::Object(map)
}
