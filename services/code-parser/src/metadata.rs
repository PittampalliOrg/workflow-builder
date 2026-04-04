use std::collections::HashMap;

use crate::{
    model::{DynamicInput, SemanticParam},
    schema::type_to_schema,
};

#[derive(Debug, Default)]
pub struct ParserMetadata {
    pub resource_types: HashMap<String, String>,
    pub dynamic_inputs: Vec<DynamicInput>,
}

pub fn parse_metadata(source: &str) -> ParserMetadata {
    let mut metadata = ParserMetadata::default();

    for line in source.lines() {
        let trimmed = strip_comment_prefix(line);
        if trimmed.is_empty() {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("@wf-resource ") {
            if let Some((name, resource_type)) = parse_resource_directive(rest) {
                metadata.resource_types.insert(name, resource_type);
            }
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("@wf-dynamic-options ") {
            if let Some(dynamic_input) = parse_dynamic_input_directive(rest) {
                metadata.dynamic_inputs.push(dynamic_input);
            }
        }
    }

    metadata
}

pub fn apply_metadata(params: &mut [SemanticParam], metadata: &ParserMetadata) {
    for (name, resource_type) in &metadata.resource_types {
        let mut applied = false;

        for param in params.iter_mut() {
            if param.name == *name {
                param.type_model.resource_type = Some(resource_type.clone());
                param.schema = type_to_schema(&param.type_model);
                applied = true;
                break;
            }
        }

        if applied {
            continue;
        }

        for param in params.iter_mut() {
            if let Some(property) = param
                .type_model
                .properties
                .iter_mut()
                .find(|property| property.name == *name)
            {
                property.type_model.resource_type = Some(resource_type.clone());
                param.schema = type_to_schema(&param.type_model);
                break;
            }
        }
    }

    for param in params.iter_mut() {
        if let Some(dynamic_input) = metadata
            .dynamic_inputs
            .iter()
            .find(|item| item.name == param.name)
        {
            param.dynamic_input = Some(dynamic_input.clone());
        }
    }
}

fn strip_comment_prefix(line: &str) -> &str {
    line.trim()
        .trim_start_matches('/')
        .trim_start_matches('*')
        .trim_start_matches('#')
        .trim()
}

fn parse_resource_directive(value: &str) -> Option<(String, String)> {
    let mut parts = value.split_whitespace();
    let name = parts.next()?.trim().to_string();
    let resource_type = parts.next()?.trim().to_string();
    if name.is_empty() || resource_type.is_empty() {
        return None;
    }
    Some((name, resource_type))
}

fn parse_dynamic_input_directive(value: &str) -> Option<DynamicInput> {
    let mut parts = value.split_whitespace();
    let name = parts.next()?.trim().to_string();
    let handler = parts.next()?.trim().to_string();
    if name.is_empty() || handler.is_empty() {
        return None;
    }

    let mut depends_on = Vec::new();
    let mut search = false;

    for token in parts {
        if let Some(values) = token.strip_prefix("dependsOn=") {
            depends_on.extend(
                values
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_string),
            );
            continue;
        }

        if token == "search" || token == "search=true" {
            search = true;
        }
    }

    Some(DynamicInput {
        name,
        handler,
        depends_on,
        search,
    })
}
