//! What changes for a household after the first death (#34).
//!
//! Everything here is expressed as `CashFlowStream`s the main loop already
//! knows how to run, so the survivor transition adds no branch to the
//! simulation loop itself. The two exceptions, handled in `sim::simulate`,
//! are the expense step-down (a per-period factor on household spending) and
//! the filing-status change (a `TaxModel` — see `strategies::SurvivorTax`).
//!
//! Mortality is deterministic here (`Person::life_expectancy_age`), so the
//! transition month is known before the loop starts.

use crate::model::{
    CashFlowStream, GrowthRule, Person, Plan, SocialSecurityBenefit, StreamBoundary,
    StreamDirection, StreamKind, YearMonth, WIDOW_BENEFIT_EARLIEST_AGE,
};

use super::SimWarning;

/// Materializes `plan.social_security` into Income streams, applying the
/// survivor rule at the first death: the household stops drawing two
/// benefits, and the survivor draws the larger of their own and a
/// widow(er)'s benefit on the decedent's record — SSA's figure, not the
/// decedent's own check (`SocialSecurityBenefit::widow_benefit`, #171).
///
/// The simplifications, stated plainly because they are user-visible:
///
/// - The larger benefit is picked in today's dollars. That is the same
///   ranking as at the transition month whenever both benefits share a COLA,
///   which they do unless one carries a `cola_override`.
/// - A survivor who has their own benefit on the plan steps up no earlier
///   than their own claiming month. SSA lets the survivor benefit be taken
///   separately, as early as 60 — the classic "take the survivor benefit
///   now, delay your own to 70" move — but a plan carries one claiming age
///   per person, and the survivor benefit is reduced for the month it does
///   start.
/// - A survivor with *no* benefit of their own draws the widow(er)'s
///   benefit from the death, or from 60 if they are younger. Benefits
///   before 60 for a disability or a child in care are not modelled: the
///   plan records neither.
/// - A household that leaves *more than one* survivor is left alone
///   entirely: everyone keeps their own benefit to their own death. A
///   survivor benefit goes to a spouse, and this model has no relationships
///   in it — with two people left there is no way to tell which of them the
///   benefit transfers to, and handing it to each is worse than not
///   modelling it.
pub(super) fn social_security_streams(
    plan: &Plan,
    warnings: &mut Vec<SimWarning>,
) -> Vec<CashFlowStream> {
    let cola = plan.assumptions.social_security_cola;

    let mut resolved: Vec<(&SocialSecurityBenefit, &Person)> = Vec::new();
    for ss in &plan.social_security {
        match plan.person(&ss.owner) {
            Some(person) => resolved.push((ss, person)),
            None => warnings.push(SimWarning::UnknownPersonRef {
                stream: ss.id.clone(),
            }),
        }
    }

    let survivor = plan.first_death().and_then(|(death, decedent)| {
        match plan.survivors_after(death).count() {
            1 => Some((death, decedent, plan.survivors_after(death).next()?)),
            _ => None,
        }
    });
    let Some((death, decedent, survivor)) = survivor else {
        return resolved
            .iter()
            .map(|(ss, person)| ss.to_stream(person, cola))
            .collect();
    };

    let mut streams: Vec<CashFlowStream> = Vec::new();
    for (ss, person) in &resolved {
        let mut stream = ss.to_stream(person, cola);
        // A survivor's own benefit runs only to the first death; from there
        // the household draws a single benefit, materialized below.
        if person.id != decedent.id {
            stream.end = StreamBoundary::Date(death);
        }
        streams.push(stream);
    }

    // The survivor draws the larger of their own benefit and a widow(er)'s
    // benefit on the decedent's record, computed by SSA's rules
    // (`SocialSecurityBenefit::widow_benefit`) for the month it starts.
    let own = resolved.iter().find(|(_, p)| p.id == survivor.id);
    let record = resolved.iter().find(|(_, p)| p.id == decedent.id);
    let start = match own {
        Some((ss, _)) => survivor.month_at_age(ss.claiming_age).max(death),
        None => survivor.month_at_age(WIDOW_BENEFIT_EARLIEST_AGE).max(death),
    };
    let widow = record.map(|(ss, p)| (ss, ss.widow_benefit(p, death, survivor, start)));
    let own = own.map(|(ss, p)| (ss, ss.annual_benefit(p)));
    let larger = [own, widow]
        .into_iter()
        .flatten()
        .max_by(|(_, a), (_, b)| a.total_cmp(b));
    if let Some((benefit, amount)) = larger {
        streams.push(CashFlowStream {
            id: format!("ss-survivor-{}", survivor.id),
            name: format!("{}'s survivor Social Security", survivor.name),
            owner: Some(survivor.id.clone()),
            direction: StreamDirection::Income,
            annual_amount: amount,
            start: StreamBoundary::Date(start),
            end: StreamBoundary::AtDeath(survivor.id.clone()),
            growth: GrowthRule::Fixed(benefit.cola_override.unwrap_or(cola)),
            survivor_percentage: None,
            kind: StreamKind::General,
        });
    }
    streams
}

/// The reduced continuations of every stream carrying a
/// `survivor_percentage` — a pension's or annuity's survivor annuity — each
/// paired with the plan stream it continues, whose start a pension's COLA
/// is still counted from after the death (`StreamKind::Pension`).
///
/// Each one starts at its owner's death and runs to the end of the plan,
/// which is the last survivor's death: a continuation whose owner is the
/// last to die is a zero-length window and contributes nothing, with no
/// special case needed. The owner's own portion is stopped at that same
/// month by `simulate` clamping the base stream's end, so the two never
/// overlap.
///
/// The continuation is household income (`owner: None`) rather than the
/// decedent's: it is paid to whoever is left, and tagging it with a dead
/// person would feed their salary tally, which drives percent-of-salary
/// contributions.
pub(super) fn stream_continuations(plan: &Plan) -> Vec<(CashFlowStream, &CashFlowStream)> {
    plan.streams
        .iter()
        .filter_map(|stream| {
            let percentage = stream.survivor_percentage?;
            let owner = plan.person(stream.owner.as_ref()?)?;
            let continuation = CashFlowStream {
                id: format!("survivor-{}", stream.id),
                name: format!("{} (survivor share)", stream.name),
                owner: None,
                direction: stream.direction,
                annual_amount: stream.annual_amount * percentage,
                start: StreamBoundary::Date(owner.month_at_age(owner.life_expectancy_age)),
                end: StreamBoundary::PlanEnd,
                growth: stream.growth,
                survivor_percentage: None,
                kind: stream.kind,
            };
            Some((continuation, stream))
        })
        .collect()
}

/// The month a stream owned by `owner` stops paying its full amount when it
/// carries a survivor percentage: the owner's death, whatever its own end
/// boundary says. `None` for streams that are not in that case, which is
/// most of them.
pub(super) fn full_amount_ends_at(plan: &Plan, stream: &CashFlowStream) -> Option<YearMonth> {
    stream.survivor_percentage?;
    let owner = plan.person(stream.owner.as_ref()?)?;
    Some(owner.month_at_age(owner.life_expectancy_age))
}
