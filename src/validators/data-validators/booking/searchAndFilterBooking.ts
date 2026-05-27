import z from "zod";

export const searchAndFilterBookingSchema = z.object({
  searchText: z.string().optional().or(z.literal("")),
  bookingStatus: z.enum(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED"]).optional().or(z.literal("")),
  paymentStatus: z.enum(["PAID", "PENDING"]).optional().or(z.literal("")),
  checkInDate: z.string().optional().or(z.literal("")), // ISO date string
  page: z.preprocess((val) => {
    if (typeof val === 'string' && val.trim() !== '') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }, z.number().integer().positive().optional()),
  limit: z.preprocess((val) => {
    if (typeof val === 'string' && val.trim() !== '') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }, z.number().integer().positive().optional()),
});

export type searchAndFilterBookingData = z.infer<typeof searchAndFilterBookingSchema>;