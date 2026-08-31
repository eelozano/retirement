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
    StreamDirection, YearMonth,
};

use super::SimWarning;

/// Materializes `plan.social_security` into Income streams, applying the
/// survivor rule at the first death: the household stops drawing two
/// benefits and the survivor keeps the larger of the two.
///
/// The simplifications, stated plainly because they are user-visible:
///
/// - The larger benefit is picked in today's dollars. That is the same
///   ranking as at the transition month whenever both benefits share a COLA,
///   which they do unless one carries a `cola_override`.
/// - A survivor who has their own benefit on the plan steps up no earlier
///   than their own claiming month. Real survivor benefits can start at 60,
///   independently of one's own — the classic "take the survivor benefit
///   now, delay your own to 70" move — but that needs a reduction schedule
///   this engine does not model, and starting later is the conservative
///   error.
/// - A survivor with *no* benefit of their own inherits the decedent's from
///   the death itself. Modelling nothing at all would be plainly wrong for
///   the common one-earner household, where the survivor is entitled to the
///   decedent's benefit.
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

    let own = resolved.iter().find(|(_, p)| p.id == survivor.id);
    let larger = [own, resolved.iter().find(|(_, p)| p.id == decedent.id)]
        .into_iter()
        .flatten()
        .max_by(|(a, _), (b, _)| a.annual_benefit().total_cmp(&b.annual_benefit()));
    if let Some((benefit, _)) = larger {
        let start = match own {
            Some((ss, _)) => survivor.month_at_age(ss.claiming_age).max(death),
            None => death,
        };
        streams.push(CashFlowStream {
            id: format!("ss-survivor-{}", survivor.id),
            name: format!("{}'s survivor Social Security", survivor.name),
            owner: Some(survivor.id.clone()),
            direction: StreamDirection::Income,
            annual_amount: benefit.annual_benefit(),
            start: StreamBoundary::Date(start),
            end: StreamBoundary::AtDeath(survivor.id.clone()),
            growth: GrowthRule::Fixed(benefit.cola_override.unwrap_or(cola)),
            survivor_percentage: None,
        });
    }
    streams
}

/// The reduced continuations of every stream carrying a
/// `survivor_percentage` — a pension's or annuity's survivor annuity.
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
pub(super) fn stream_continuations(plan: &Plan) -> Vec<CashFlowStream> {
    plan.streams
        .iter()
        .filter_map(|stream| {
            let percentage = stream.survivor_percentage?;
            let owner = plan.person(stream.owner.as_ref()?)?;
            Some(CashFlowStream {
                id: format!("survivor-{}", stream.id),
                name: format!("{} (survivor share)", stream.name),
                owner: None,
                direction: stream.direction,
                annual_amount: stream.annual_amount * percentage,
                start: StreamBoundary::Date(owner.month_at_age(owner.life_expectancy_age)),
                end: StreamBoundary::PlanEnd,
                growth: stream.growth,
                survivor_percentage: None,
            })
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
