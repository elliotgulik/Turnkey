# Google Earth quoting and TurnKey job records

## Quoting

Install the current extension from `/assets/turnkey-earth-extension-0.2.2.zip` on your TurnKey site: unzip it, open `chrome://extensions`, enable Developer mode, choose Load unpacked and select the folder containing `manifest.json`. Remove or disable older copies. Refresh both TurnKey and Google Earth after updating. Sign in through the extension using the same TurnKey business.

Use **Build quote** on a saved customer with an address. The extension opens Google Earth at that address and locks the quote to that customer. Measurements and prices produce a new draft opportunity under the existing customer; previously accepted quotes remain unchanged. A plain Google Earth link without the extension opens the address but cannot automatically attach a draft to the customer.

In Earth, measure services and choose **Instant Quote**. The internal panel shows labour, chemicals, travel/fuel, equipment, consumables and allocated overheads, plus recommended price, editable final price, GST and expected margin. These are estimates using the business cost settings, not actual job expenses. Travel uses a manual round-trip estimate or the configured business average, not a live traffic calculation. Public customer quotes do not receive internal cost/margin fields.

For 3D measurements, wait for imagery to settle and select a corner/edge before repositioning it on the loaded surface. Ground measurements and measured 3D surfaces have different meanings; satellite imagery cannot guarantee survey-grade or fully automatic hidden-surface measurements.

## Job photos

Open a job's details and its **Job records** section. Upload Before or After images. Images are stored against the job in the existing private `turnkey-uploads` bucket; previews use short-lived signed URLs. JPEG, PNG and WebP up to 8MB are supported. This does not automatically send photos to ServiceM8 or customers.

## Hours and staff calendar

Submit start/end times against a job. Workers submit their own hours; owners/managers can review staff entries. The staff calendar displays **actual submitted hours**, rather than planned dispatch, payroll or ServiceM8 appointments. Overlapping worker entries are rejected. An identical retry must preserve its submission ID so time is not added twice.

## Equipment

Add each physical machine with its service interval and starting meter. Enter that machine's actual runtime with the work log; do not multiply it by the number of workers. Runtime cannot exceed the logged work window, and overlapping usage of one machine is rejected. Service alerts remain visible in TurnKey until the equipment is recorded as serviced. Service records preserve earlier runtime/history.

## Deployment

Frontend and backend must deploy together. Apply `supabase/migrations/20261018031355_job_work_records.sql` followed by `supabase/migrations/20261018033149_job_work_extension_schema.sql` to the correct Supabase project; do not blindly apply unrelated pending migrations. It adds equipment assets, work logs, equipment usage and service events, restricted to the trusted backend, plus transactional write functions. Existing customers/jobs/quotes/attachments are retained. No new external credentials are needed.

Local tests cover database constraints and endpoint authorization. Real uploads and worker submissions still need a user acceptance check after deployment; do not create fake records in the production business just to claim a live test.
