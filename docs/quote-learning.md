# Quote learning

TurnKey uses an explainable calibration model, not an autonomous geometry or image-recognition model. It begins with the business's current service rates and target-margin cost estimate. It learns only from newly finalised, durably saved quotes with explicit adjustment reasons (unchanged baseline prices count as neutral pricing decisions). Historical quotes without the original recommendation and context are not guessed into training data.

Comparable examples share service, measurement unit, storeys and access conditions. At least five distinct quotes are needed. Robust median price ratios are shrunk toward the configured baseline and limited by the owner's maximum adjustment. Recommendations cannot fall below the current allocated target-margin floor. Manual overrides remain possible and retain the existing low-margin warnings.

Discounts, unmeasured extra work and measurement corrections do not train the standard price adjustment. A measurement correction records the original measured quantity and the verified quantity separately. It never changes satellite imagery, moves an outline or treats a higher price as proof of a larger property. Future quantity hints need verification and explicit application.

Settings → Pricing → Quote learning lets an owner or manager disable learned recommendations, increase the sample threshold, limit adjustments, exclude a decision or reset history. Resetting learning leaves customers, quotes, configured rates and original map outlines untouched. Accepted quote totals are never repriced.

Quote acceptance and recorded work remain linked through the saved job ID. Logged work time is an actual time record; estimated quote costs stay labelled estimates. No actual profit is inferred from an invoice or payment amount.

The private learning engine and history are never loaded by public booking or quote approval pages. Backend authentication resolves the business; a request cannot choose a different business's learning data. Repeated saves use the same quote/line identity so retries do not add training weight.

A failed history update does not undo a saved customer quote. TurnKey shows a warning and offers a retry. The quote is always stored before a learning decision is submitted.
