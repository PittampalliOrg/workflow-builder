use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Typescript,
    Python,
}

#[derive(Debug, Deserialize)]
pub struct ParseRequest {
    pub language: Language,
    pub source: String,
    #[serde(default)]
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub supporting_files: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct BatchParseRequest {
    pub items: Vec<ParseRequest>,
}

#[derive(Debug, Serialize)]
pub struct ParseResponse {
    pub model: CodeFunctionModel,
}

#[derive(Debug, Serialize)]
pub struct BatchParseResponse {
    pub items: Vec<CodeFunctionModel>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeFunctionModel {
    pub language: Language,
    pub entrypoint: String,
    pub is_async: bool,
    pub imports: Vec<ImportRef>,
    pub params: Vec<SemanticParam>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dynamic_inputs: Vec<DynamicInput>,
    pub return_type: SemanticType,
    pub schema: Value,
    pub diagnostics: Vec<Diagnostic>,
    pub capabilities: CapabilityFlags,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapabilityFlags {
    pub has_enums: bool,
    pub has_nested_objects: bool,
    pub has_nullable_types: bool,
    pub has_relative_imports: bool,
    pub has_resource_types: bool,
    pub has_dynamic_inputs: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportRef {
    pub specifier: String,
    pub kind: ImportKind,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DynamicInput {
    pub name: String,
    pub handler: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub search: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportKind {
    Local,
    External,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticParam {
    pub name: String,
    pub required: bool,
    pub description: Option<String>,
    pub default_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic_input: Option<DynamicInput>,
    #[serde(rename = "type")]
    pub type_model: SemanticType,
    pub schema: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SemanticProperty {
    pub name: String,
    #[serde(rename = "type")]
    pub type_model: SemanticType,
    pub required: bool,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SemanticType {
    pub kind: SemanticTypeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_type: Option<Box<SemanticType>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<SemanticProperty>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<SemanticType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SemanticTypeKind {
    String,
    Number,
    Boolean,
    Array,
    Object,
    Enum,
    Union,
    Null,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

impl SemanticType {
    pub fn string(nullable: bool) -> Self {
        Self {
            kind: SemanticTypeKind::String,
            name: None,
            nullable,
            item_type: None,
            properties: vec![],
            variants: vec![],
            enum_values: vec![],
            resource_type: None,
            original: None,
        }
    }

    pub fn number(nullable: bool) -> Self {
        Self { kind: SemanticTypeKind::Number, ..Self::string(nullable) }
    }

    pub fn boolean(nullable: bool) -> Self {
        Self { kind: SemanticTypeKind::Boolean, ..Self::string(nullable) }
    }

    pub fn array(item: SemanticType, nullable: bool) -> Self {
        Self {
            kind: SemanticTypeKind::Array,
            item_type: Some(Box::new(item)),
            ..Self::string(nullable)
        }
    }

    pub fn object(name: Option<String>, properties: Vec<SemanticProperty>, nullable: bool) -> Self {
        Self {
            kind: SemanticTypeKind::Object,
            name,
            properties,
            nullable,
            item_type: None,
            variants: vec![],
            enum_values: vec![],
            resource_type: None,
            original: None,
        }
    }

    pub fn enumeration(values: Vec<Value>, nullable: bool) -> Self {
        Self {
            kind: SemanticTypeKind::Enum,
            enum_values: values,
            ..Self::string(nullable)
        }
    }

    pub fn union(variants: Vec<SemanticType>, nullable: bool) -> Self {
        Self {
            kind: SemanticTypeKind::Union,
            variants,
            ..Self::string(nullable)
        }
    }

    pub fn null() -> Self {
        Self { kind: SemanticTypeKind::Null, ..Self::string(true) }
    }

    pub fn unknown() -> Self {
        Self { kind: SemanticTypeKind::Unknown, ..Self::string(false) }
    }

    pub fn unknown_named(name: &str) -> Self {
        Self {
            name: Some(name.to_string()),
            ..Self::unknown()
        }
    }

    pub fn has_enums(&self) -> bool {
        matches!(self.kind, SemanticTypeKind::Enum)
            || self.properties.iter().any(|property| property.type_model.has_enums())
            || self
                .item_type
                .as_ref()
                .map(|item| item.has_enums())
                .unwrap_or(false)
            || self.variants.iter().any(SemanticType::has_enums)
    }

    pub fn has_nested_objects(&self) -> bool {
        (!self.properties.is_empty())
            || self
                .item_type
                .as_ref()
                .map(|item| item.has_nested_objects())
                .unwrap_or(false)
            || self.variants.iter().any(SemanticType::has_nested_objects)
    }

    pub fn has_nullable(&self) -> bool {
        self.nullable
            || self
                .item_type
                .as_ref()
                .map(|item| item.has_nullable())
                .unwrap_or(false)
            || self.properties.iter().any(|property| property.type_model.has_nullable())
            || self.variants.iter().any(SemanticType::has_nullable)
    }

    pub fn has_resource_types(&self) -> bool {
        self.resource_type.is_some()
            || self
                .item_type
                .as_ref()
                .map(|item| item.has_resource_types())
                .unwrap_or(false)
            || self
                .properties
                .iter()
                .any(|property| property.type_model.has_resource_types())
            || self.variants.iter().any(SemanticType::has_resource_types)
    }
}
