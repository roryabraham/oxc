//! Experimental instruction scheduling for memoization.
//!
//! Unlike the TS implementation, this opt-in pass delays inert constructions until their first
//! use within a basic block. Shorter construction lifetimes can avoid overlapping reactive scopes
//! or scopes containing an unrelated hook. Calls, property accesses, coercions and control flow
//! retain their execution order; this is not a purity inference pass.

use rustc_hash::{FxHashMap, FxHashSet};

use crate::react_compiler_hir::environment::Environment;
use crate::react_compiler_hir::visitors::{each_instruction_lvalue, each_instruction_operand};
use crate::react_compiler_hir::{
    ArrayElement, BlockKind, DeclarationId, HirFunction, InstructionKind, InstructionValue,
    ObjectPropertyKey, ObjectPropertyOrSpread, ObjectPropertyType, Terminal,
};
use crate::react_compiler_lowering::mark_instruction_ids;

/// Sink inert producers, preserving dependencies and the order of all other instructions.
///
/// Scheduling precedes alias/effect and mutable-range inference, so those analyses see the final
/// instruction order. No instruction crosses a block boundary or a manual-memoization marker.
pub fn reorder_instructions(func: &mut HirFunction, env: &Environment) {
    if !func.instructions.iter().any(|instruction| {
        matches!(
            instruction.value,
            InstructionValue::ArrayExpression { .. }
                | InstructionValue::ObjectExpression { .. }
                | InstructionValue::FunctionExpression { .. }
        )
    }) {
        return;
    }

    // SSA versions share a source binding. Moving a read of an old version across a write to a
    // newer version is not safe: codegen can reuse that binding's name. Captured mutable bindings
    // also need their original observation point, even when the write is in a nested function.
    let mut mutable_bindings = FxHashSet::default();
    for place in &func.context {
        mutable_bindings.insert(env.identifiers[place.identifier].declaration_id);
    }
    for block in func.body.blocks.values() {
        for phi in &block.phis {
            mutable_bindings.insert(env.identifiers[phi.place.identifier].declaration_id);
        }
        for &instruction_id in &block.instructions {
            let instruction = &func.instructions[instruction_id.index()];
            match &instruction.value {
                InstructionValue::LoadContext { place, .. } => {
                    mutable_bindings.insert(env.identifiers[place.identifier].declaration_id);
                }
                value if is_mutable_binding(value) => {
                    for place in each_instruction_lvalue(instruction) {
                        mutable_bindings.insert(env.identifiers[place.identifier].declaration_id);
                    }
                }
                _ => {}
            }
        }
    }

    let mut changed = false;
    for block in func.body.blocks.values_mut() {
        // Value/sequence blocks give special meaning to their last instruction. Caught exception
        // paths and loop headers also retain their exact instruction layout.
        if block.kind != BlockKind::Block
            || matches!(block.terminal, Terminal::MaybeThrow { .. })
            || block.instructions.len() < 2
        {
            continue;
        }

        // An unnamed HIR result is an expression awaiting emission, not necessarily an evaluated
        // register. Codegen can inline it into a later consumer. Only defer expression trees made
        // entirely of inert instructions, or reads of named bindings that already materialize
        // their initializer. In particular, pin an array and its binding if an unnamed operand is
        // a getter/call; preserving only that operand's HIR position would not preserve execution.
        let mut inert_temporaries = FxHashSet::default();
        let movable: Vec<bool> = block
            .instructions
            .iter()
            .map(|&instruction_id| {
                let instruction = &func.instructions[instruction_id.index()];
                let movable = is_movable(&instruction.value, env, &mutable_bindings)
                    && each_instruction_operand(instruction, env).iter().all(|place| {
                        env.identifiers[place.identifier].name.is_some()
                            || inert_temporaries.contains(&place.identifier)
                    });
                if movable {
                    for place in each_instruction_lvalue(instruction) {
                        inert_temporaries.insert(place.identifier);
                    }
                }
                movable
            })
            .collect();

        let mut next_use: FxHashMap<DeclarationId, usize> = FxHashMap::default();
        let mut barrier = block.instructions.len();
        let mut schedule = Vec::with_capacity(block.instructions.len());

        // A movable definition is needed no later than its earliest scheduled consumer. Walking
        // backwards propagates that deadline through chains of allocations, aliases and captures.
        // Ties keep source order, so producers precede consumers at the same deadline.
        for (index, &instruction_id) in block.instructions.iter().enumerate().rev() {
            let instruction = &func.instructions[instruction_id.index()];
            let operands = each_instruction_operand(instruction, env);
            let lvalues = each_instruction_lvalue(instruction);
            let mut destination = index;

            if movable[index] {
                destination = barrier;
                for place in &lvalues {
                    let declaration = env.identifiers[place.identifier].declaration_id;
                    destination = destination.min(*next_use.get(&declaration).unwrap_or(&barrier));
                }
                destination = destination.max(index);
            }

            if is_barrier(&instruction.value) {
                barrier = index;
            }
            for place in operands {
                let declaration = env.identifiers[place.identifier].declaration_id;
                next_use
                    .entry(declaration)
                    .and_modify(|next| *next = (*next).min(destination))
                    .or_insert(destination);
            }
            schedule.push((destination, index, instruction_id));
        }

        schedule.sort_unstable_by_key(|&(destination, index, _)| (destination, index));
        for (slot, (_, _, instruction_id)) in block.instructions.iter_mut().zip(schedule) {
            changed |= *slot != instruction_id;
            *slot = instruction_id;
        }
    }

    if changed {
        mark_instruction_ids(&mut func.body, &mut func.instructions);
    }
}

/// An allowlist of instructions that neither execute user code nor observe mutable state.
/// Their operands have already been evaluated by separate HIR instructions.
fn is_movable(
    value: &InstructionValue,
    env: &Environment,
    mutable_bindings: &FxHashSet<DeclarationId>,
) -> bool {
    match value {
        InstructionValue::Primitive { .. } | InstructionValue::TypeCastExpression { .. } => true,
        InstructionValue::LoadLocal { place, .. } => {
            !mutable_bindings.contains(&env.identifiers[place.identifier].declaration_id)
        }
        InstructionValue::StoreLocal { lvalue, .. } => {
            lvalue.kind == InstructionKind::Const
                && !mutable_bindings
                    .contains(&env.identifiers[lvalue.place.identifier].declaration_id)
        }
        InstructionValue::ArrayExpression { elements, .. } => {
            elements.iter().all(|element| !matches!(element, ArrayElement::Spread(_)))
        }
        InstructionValue::ObjectExpression { properties, .. } => {
            properties.iter().all(|property| match property {
                ObjectPropertyOrSpread::Property(property)
                    if property.property_type == ObjectPropertyType::Property =>
                {
                    match &property.key {
                        ObjectPropertyKey::String { name, .. }
                        | ObjectPropertyKey::Identifier { name, .. } => *name != "__proto__",
                        ObjectPropertyKey::Computed { .. } => false,
                    }
                }
                _ => false,
            })
        }
        InstructionValue::FunctionExpression { lowered_func, .. } => {
            env.functions[lowered_func.func].context.iter().all(|place| {
                !mutable_bindings.contains(&env.identifiers[place.identifier].declaration_id)
            })
        }
        _ => false,
    }
}

fn is_binding_barrier(value: &InstructionValue) -> bool {
    match value {
        InstructionValue::StoreLocal { lvalue, .. } => lvalue.kind != InstructionKind::Const,
        InstructionValue::Destructure { lvalue, .. } => lvalue.kind != InstructionKind::Const,
        InstructionValue::DeclareLocal { .. }
        | InstructionValue::DeclareContext { .. }
        | InstructionValue::StoreContext { .. }
        | InstructionValue::PrefixUpdateLocal { .. }
        | InstructionValue::PostfixUpdateLocal { .. }
        | InstructionValue::PrefixUpdateContext { .. }
        | InstructionValue::PostfixUpdateContext { .. } => true,
        _ => false,
    }
}

fn is_mutable_binding(value: &InstructionValue) -> bool {
    match value {
        InstructionValue::StoreLocal { lvalue, .. } => {
            !matches!(lvalue.kind, InstructionKind::Const | InstructionKind::Let)
        }
        InstructionValue::Destructure { lvalue, .. } => {
            !matches!(lvalue.kind, InstructionKind::Const | InstructionKind::Let)
        }
        value => is_binding_barrier(value),
    }
}

fn is_barrier(value: &InstructionValue) -> bool {
    is_binding_barrier(value)
        || matches!(
            value,
            InstructionValue::Debugger { .. }
                | InstructionValue::TSEnumDeclaration { .. }
                | InstructionValue::StartMemoize { .. }
                | InstructionValue::FinishMemoize { .. }
        )
}
